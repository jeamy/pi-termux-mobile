package org.pimobile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foreground service owning the Node bridge process.
 * Layout under filesDir:
 *   usr/      termux prefix (bin, lib, etc.)
 *   home/     HOME ($HOME/.pi/agent for auth.json, $HOME/.pi-mobile for bridge state)
 *   work/     default agent working directory
 *   runtime/  server.mjs + node_modules
 *   tmp/      TMPDIR
 *
 * Exactly one node process runs per service. Every Activity start calls
 * startForegroundService(); that must not restart a running bridge, because
 * a restart interrupts the agent's running tool calls and pi-durable allows a
 * single storage owner. A supervisor restarts node with backoff if it dies.
 *
 * Beside node runs the phone's space server, runtime/bin/phi-space-server (M1, phi-spaces docs/m1-mobile.en.md), when
 * the APK carries it: its own process with its own supervisor, so a node restart or crash leaves the space running.
 * It keeps its store in home/.pi-mobile/space-server.sqlite and listens only on the unix socket
 * home/.pi-mobile/space-server.sock, which node reaches as the agent host (PI_MOBILE_SPACE).
 */
public final class PiService extends Service {

    private static final String CHANNEL = "pi-runtime";
    private static final long STOP_GRACE_MS = 8000;

    private final Object lock = new Object();
    private Process nodeProcess;
    private Thread supervisor;
    private Process spaceProcess;
    private Thread spaceSupervisor;
    private volatile boolean stopping;
    private PowerManager.WakeLock wakeLock;
    private SpaceKeyStore spaceKeys;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundWithNotification();
        acquireWakeLock();
        synchronized (lock) {
            if (spaceKeys == null) try { spaceKeys = new SpaceKeyStore(this); } catch (Exception e) { logError("space keystore failed", e); stopSelf(); return START_NOT_STICKY; }
            if (supervisor != null && supervisor.isAlive()) return START_STICKY; // already running
            stopping = false;
            supervisor = new Thread(this::superviseNode, "pi-supervisor");
            supervisor.start();
        }
        return START_STICKY;
    }

    /** Install if needed, then keep one node process alive (restart with backoff). */
    private void superviseNode() {
        try {
            if (!RuntimeInstaller.isInstalled(this)) {
                terminateOrphanServer(); // must not run while its files are replaced
                terminateOrphans("phi-space-server");
                RuntimeInstaller.install(this);
            }
        } catch (Exception e) {
            logError("install failed", e);
            stopSelf();
            return;
        }
        if (spaceBinary().isFile()) {
            synchronized (lock) {
                if (!stopping && (spaceSupervisor == null || !spaceSupervisor.isAlive())) {
                    spaceSupervisor = new Thread(() -> superviseLoop("space server", this::startSpaceServer, true), "pi-space-supervisor");
                    spaceSupervisor.start();
                }
            }
        }
        superviseLoop("node", this::startNode, false);
    }

    private interface Starter { Process start() throws IOException; }

    /** Keeps one process alive: restarts it with backoff (1 s doubling to 30 s, quick again after a minute's run). */
    private void superviseLoop(String name, Starter starter, boolean space) {
        long backoff = 1000;
        while (!stopping) {
            long started = System.currentTimeMillis();
            Process p;
            try {
                p = starter.start();
            } catch (Exception e) {
                logError(name + " start failed", e);
                p = null;
            }
            if (p != null) {
                synchronized (lock) { if (space) spaceProcess = p; else nodeProcess = p; }
                try {
                    int code = p.waitFor();
                    if (!stopping) logError(name + " exited " + code + "; restarting", null);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
                synchronized (lock) { if (space) { if (spaceProcess == p) spaceProcess = null; } else if (nodeProcess == p) nodeProcess = null; }
            }
            if (stopping) return;
            // a process that ran for a while gets a quick restart again
            if (System.currentTimeMillis() - started > 60_000) backoff = 1000;
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, 30_000);
        }
    }

    private File spaceBinary() { return new File(new File(new File(getFilesDir(), "runtime"), "bin"), "phi-space-server"); }
    private File spaceSocket() { return new File(new File(new File(getFilesDir(), "home"), ".pi-mobile"), "space-server.sock"); }

    private Process startSpaceServer() throws IOException {
        terminateOrphans("phi-space-server"); // one left from a killed app process holds the store
        File state = spaceSocket().getParentFile();
        state.mkdirs();
        List<String> cmd = new ArrayList<>();
        cmd.add(spaceBinary().getAbsolutePath());
        cmd.add("--store"); cmd.add(new File(state, "space-server.sqlite").getAbsolutePath());
        cmd.add("--listen"); cmd.add("unix:" + spaceSocket().getAbsolutePath());
        cmd.add("--peer"); cmd.add("phone");
        cmd.add("--agent-host");
        Map<String, String> env = new HashMap<>();
        env.put("HOME", new File(getFilesDir(), "home").getAbsolutePath());
        env.put("TMPDIR", new File(getFilesDir(), "tmp").getAbsolutePath());
        File log = new File(getFilesDir(), "log/space-server.log");
        try {
            return spawn(cmd, env, state, log);
        } catch (IOException directFailed) {
            cmd.add(0, "/system/bin/linker64");
            return spawn(cmd, env, state, log);
        }
    }

    private Process startNode() throws IOException {
        File files = getFilesDir();
        File prefix = new File(files, "usr");
        File home = new File(files, "home");
        File runtime = new File(files, "runtime");

        Map<String, String> env = new HashMap<>();
        env.put("HOME", home.getAbsolutePath());
        env.put("PREFIX", prefix.getAbsolutePath());
        env.put("TMPDIR", new File(files, "tmp").getAbsolutePath());
        env.put("PATH", prefix.getAbsolutePath() + "/bin:/system/bin:/system/xbin");
        env.put("LD_LIBRARY_PATH", prefix.getAbsolutePath() + "/lib");
        env.put("TERM", "dumb");
        env.put("LANG", "C.UTF-8");
        env.put("PI_WORKDIR", new File(files, "work").getAbsolutePath());
        env.put("PI_SHELL", new File(prefix, "bin/bash").getAbsolutePath());
        // Termux-built openssl hardcodes /data/data/com.termux paths — point at ours.
        env.put("OPENSSL_CONF", new File(prefix, "etc/tls/openssl.cnf").getAbsolutePath());
        env.put("SSL_CERT_FILE", new File(prefix, "etc/tls/cert.pem").getAbsolutePath());
        env.put("PHI_SPACES_KEY_SOCKET", SpaceKeyStore.socketName());
        if (spaceBinary().isFile()) env.put("PI_MOBILE_SPACE", "unix:" + spaceSocket().getAbsolutePath());

        // a stale port file would make the UI load a dead bridge address
        new File(new File(home, ".pi-mobile"), "port").delete();

        String node = new File(prefix, "bin/node").getAbsolutePath();
        String server = new File(runtime, "server.mjs").getAbsolutePath();

        List<String> cmd = new ArrayList<>();
        cmd.add(node);
        cmd.add(server);
        try {
            return spawn(cmd, env, home, nodeLog());
        } catch (IOException directFailed) {
            // targetSdk >= 29 on Android 10+: exec of app-private files is
            // blocked -> run the ELF through the system dynamic linker.
            cmd.set(0, "/system/bin/linker64");
            cmd.add(1, node);
            return spawn(cmd, env, home, nodeLog());
        }
    }

    private File nodeLog() { return new File(getFilesDir(), "log/node.log"); }

    private Process spawn(List<String> cmd, Map<String, String> env, File cwd, File log) throws IOException {
        log.getParentFile().mkdirs();
        rotateLog(log);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().putAll(env);
        pb.directory(cwd);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        return pb.start();
    }

    private static void rotateLog(File log) {
        if (log.length() > 4L * 1024 * 1024) {
            File old = new File(log.getPath() + ".1");
            old.delete();
            log.renameTo(old);
        }
    }

    /**
     * Graceful stop: SIGTERM (server.mjs closes the harness and releases its
     * storage lock), wait, then kill. The pid comes from server.mjs's lock file.
     */
    private void stopNode() {
        Process p;
        synchronized (lock) { p = nodeProcess; }
        if (p == null) return;
        int pid = readServerPid();
        if (pid > 0) {
            try { android.os.Process.sendSignal(pid, 15); } catch (Exception ignored) { }
        } else {
            p.destroy();
        }
        try {
            if (!p.waitFor(STOP_GRACE_MS, TimeUnit.MILLISECONDS)) {
                p.destroyForcibly();
                p.waitFor(2000, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException ie) {
            p.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    /** SIGTERM (the binary closes its store and exits), wait, then kill. After node, which uses it. */
    private void stopSpaceServer() {
        Process p;
        synchronized (lock) { p = spaceProcess; }
        if (p == null) return;
        terminateOrphans("phi-space-server"); // finds it by its command line: SIGTERM, then SIGKILL after 5 s
        try { p.waitFor(1000, TimeUnit.MILLISECONDS); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
        p.destroyForcibly();
    }

    /** A node left over from a killed app process (same uid) still owns the storage. */
    private void terminateOrphanServer() {
        int pid = readServerPid();
        if (pid <= 0 || !isServerProcess(pid)) return;
        android.os.Process.sendSignal(pid, 15);
        for (int i = 0; i < 80 && isServerProcess(pid); i++) {
            try { Thread.sleep(100); } catch (InterruptedException ie) { return; }
        }
        if (isServerProcess(pid)) android.os.Process.sendSignal(pid, 9);
    }

    /**
     * Ends the processes of this app (same uid) whose command line runs a file of runtime/bin named `name`: SIGTERM,
     * up to 5 s, then SIGKILL. Only those not supervised now (none is, when called).
     */
    private void terminateOrphans(String name) {
        String path = new File(new File(new File(getFilesDir(), "runtime"), "bin"), name).getAbsolutePath();
        List<Integer> pids = new ArrayList<>();
        File[] procs = new File("/proc").listFiles();
        if (procs == null) return;
        int self = android.os.Process.myPid();
        for (File d : procs) {
            int pid;
            try { pid = Integer.parseInt(d.getName()); } catch (NumberFormatException e) { continue; }
            if (pid != self && cmdlineHas(pid, path)) pids.add(pid);
        }
        for (int pid : pids) { logError("ending a left-over " + name + " (pid " + pid + ")", null); android.os.Process.sendSignal(pid, 15); }
        for (int i = 0; i < 50; i++) {
            boolean alive = false;
            for (int pid : pids) alive |= cmdlineHas(pid, path);
            if (!alive) return;
            try { Thread.sleep(100); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return; }
        }
        for (int pid : pids) if (cmdlineHas(pid, path)) android.os.Process.sendSignal(pid, 9);
    }

    private static boolean cmdlineHas(int pid, String text) {
        try (FileInputStream in = new FileInputStream("/proc/" + pid + "/cmdline")) {
            byte[] b = new byte[4096];
            int n = in.read(b);
            return n > 0 && new String(b, 0, n, "UTF-8").contains(text);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isServerProcess(int pid) {
        try (FileInputStream in = new FileInputStream("/proc/" + pid + "/cmdline")) {
            byte[] b = new byte[4096];
            int n = in.read(b);
            return n > 0 && new String(b, 0, n, "UTF-8").contains("server.mjs");
        } catch (Exception e) {
            return false;
        }
    }

    private int readServerPid() {
        File f = new File(new File(new File(getFilesDir(), "home"), ".pi-mobile"), "server.lock");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) Math.min(f.length(), 4096)];
            int n = in.read(b);
            Matcher m = Pattern.compile("\"pid\"\\s*:\\s*(\\d+)").matcher(new String(b, 0, Math.max(n, 0), "UTF-8"));
            return m.find() ? Integer.parseInt(m.group(1)) : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    private void logError(String msg, Exception e) {
        android.util.Log.e("PiService", msg, e);
        try {
            File f = new File(getFilesDir(), "log/service-error.txt");
            f.getParentFile().mkdirs();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write(new java.util.Date() + " " + msg + (e != null ? ": " + e : "") + "\n");
            }
        } catch (IOException ignored) { }
    }

    private void startForegroundWithNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL, "pi runtime", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE);
        Notification n;
        if (Build.VERSION.SDK_INT >= 26) {
            n = new Notification.Builder(this, CHANNEL)
                    .setContentTitle("pi mobile")
                    .setContentText("agent runtime running")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .build();
        } else {
            n = new Notification.Builder(this)
                    .setContentTitle("pi mobile")
                    .setContentText("agent runtime running")
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentIntent(pi)
                    .build();
        }
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(1, n);
        }
    }

    private synchronized void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pimobile:runtime");
            wakeLock.setReferenceCounted(false); // repeated starts must not stack holds
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        if (spaceKeys != null) { spaceKeys.close(); spaceKeys = null; }
        Thread sup, spaceSup;
        synchronized (lock) { sup = supervisor; supervisor = null; spaceSup = spaceSupervisor; spaceSupervisor = null; }
        stopNode();
        if (sup != null) sup.interrupt();
        stopSpaceServer();
        if (spaceSup != null) spaceSup.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
