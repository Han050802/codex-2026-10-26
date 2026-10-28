// AionUi 2.2.2 / AionCore 0.2.2 compatibility bridge.
// Preserve JSON-RPC line contents; scope ONLY server notifications.
// The line transport normalizes line endings to the Windows newline sequence.
// Build with the Windows .NET Framework C# compiler; no external dependencies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public sealed class ThreadNotificationFilter
{
    private readonly object gate = new object();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1024 };
    private readonly Dictionary<string, string> rootRequests = new Dictionary<string, string>();
    private readonly List<string> buffered = new List<string>();
    private string rootThread;
    private string previousRoot;
    private bool waitingForRoot;
    private int bufferedChars;
    public long Dropped { get; private set; }
    public long CompatibilityFallbacks { get; private set; }
    private const int MaxBufferedLines = 512;
    private const int MaxBufferedChars = 4 * 1024 * 1024;

    private Dictionary<string, object> Parse(string line)
    {
        try { return json.DeserializeObject(line) as Dictionary<string, object>; }
        catch { return null; } // Preserve unsupported/malformed frames verbatim.
    }
    private static object Get(Dictionary<string, object> obj, string key)
    {
        object value;
        return obj != null && obj.TryGetValue(key, out value) ? value : null;
    }
    private static Dictionary<string, object> Obj(object value) { return value as Dictionary<string, object>; }
    private static string Str(object value) { return value as string; }
    private string Id(object value) { return value == null ? null : json.Serialize(value); }
    private static string ThreadId(Dictionary<string, object> obj)
    {
        return Str(Get(obj, "threadId")) ?? Str(Get(obj, "thread_id"));
    }
    private static string NotificationOwner(string method, Dictionary<string, object> parameters)
    {
        string id = ThreadId(parameters)
            ?? Str(Get(parameters, "conversationId"))
            ?? Str(Get(parameters, "conversation_id"));
        if (id == null && method.StartsWith("thread/", StringComparison.Ordinal))
            id = Str(Get(Obj(Get(parameters, "thread")), "id"));
        return id;
    }

    public void ClientLine(string line)
    {
        lock (gate)
        {
            var frame = Parse(line);
            var method = Str(Get(frame, "method"));
            var id = Id(Get(frame, "id"));
            if (id == null || (method != "thread/start" && method != "thread/resume" && method != "thread/fork")) return;
            rootRequests[id] = method;
            previousRoot = rootThread;
            if (method == "thread/resume")
            {
                // Resume identifies the actual root; fork's threadId is its SOURCE,
                // so never bind the parent of a fork as the new root.
                var resumed = ThreadId(Obj(Get(frame, "params")));
                if (!String.IsNullOrEmpty(resumed)) { rootThread = resumed; waitingForRoot = false; return; }
            }
            rootThread = null;
            waitingForRoot = true;
        }
    }

    public List<string> ServerLine(string line)
    {
        lock (gate)
        {
            var output = new List<string>();
            var frame = Parse(line);
            string method = Str(Get(frame, "method"));
            bool hasId = frame != null && frame.ContainsKey("id");
            // Every response and server request is forwarded, including errors,
            // authentication, approvals, elicitation and future protocol methods.
            if (method == null && hasId)
            {
                string requestMethod;
                var id = Id(Get(frame, "id"));
                if (id != null && rootRequests.TryGetValue(id, out requestMethod))
                {
                    rootRequests.Remove(id);
                    var result = Obj(Get(frame, "result"));
                    var bound = Str(Get(Obj(Get(result, "thread")), "id")) ?? ThreadId(result);
                    if (!String.IsNullOrEmpty(bound)) rootThread = bound;
                    else if (frame.ContainsKey("error")) rootThread = previousRoot;
                    else if (waitingForRoot) CompatibilityFallbacks++;
                    waitingForRoot = false;
                    FlushBuffered(output);
                }
                output.Add(line);
                return output;
            }
            if (method == null || hasId || method == "serverRequest/resolved")
            {
                // A resolution may belong to a forwarded child approval. Keep it
                // so the host can retire the corresponding approval card.
                output.Add(line);
                return output;
            }
            string owner = NotificationOwner(method, Obj(Get(frame, "params")));
            if (String.IsNullOrEmpty(owner)) { output.Add(line); return output; }
            if (waitingForRoot)
            {
                buffered.Add(line);
                bufferedChars += line.Length;
                if (buffered.Count > MaxBufferedLines || bufferedChars > MaxBufferedChars)
                {
                    // Unknown protocol behavior must not deadlock or consume
                    // unbounded memory. Preserve baseline behavior and warn.
                    waitingForRoot = false;
                    CompatibilityFallbacks++;
                    FlushBuffered(output);
                }
                return output;
            }
            if (rootThread == null || String.Equals(owner, rootThread, StringComparison.Ordinal)) output.Add(line);
            else Dropped++;
            return output;
        }
    }
    private void FlushBuffered(List<string> output)
    {
        foreach (var line in buffered)
        {
            var frame = Parse(line);
            var method = Str(Get(frame, "method"));
            var owner = method == null ? null : NotificationOwner(method, Obj(Get(frame, "params")));
            if (rootThread == null || owner == null || String.Equals(owner, rootThread, StringComparison.Ordinal)) output.Add(line);
            else Dropped++;
        }
        buffered.Clear();
        bufferedChars = 0;
    }
    public List<string> EndOfStream()
    {
        lock (gate)
        {
            var output = new List<string>();
            // Preserve diagnostics if startup failed before a root response.
            if (buffered.Count > 0) { CompatibilityFallbacks++; FlushBuffered(output); }
            return output;
        }
    }
}

public static class CodexThreadBridge
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(IntPtr file, IntPtr buffer, uint count, out uint written, IntPtr overlapped);
    private static void WriteProtocolLine(IntPtr standardOutput, string line)
    {
        // .NET Framework Console.WriteLine suppresses ERROR_BROKEN_PIPE.
        // Check the actual pipe write so a disconnected host cannot leave its
        // owned app-server running indefinitely with no result consumer.
        if (standardOutput == IntPtr.Zero || standardOutput == new IntPtr(-1))
            throw new IOException("Protocol output handle is unavailable.");
        byte[] bytes = Utf8.GetBytes(line + Environment.NewLine);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            int offset = 0;
            while (offset < bytes.Length)
            {
                uint written;
                if (!WriteFile(standardOutput, IntPtr.Add(pinned.AddrOfPinnedObject(), offset), (uint)(bytes.Length - offset), out written, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    throw new IOException("Protocol output pipe write failed.", new System.ComponentModel.Win32Exception(error));
                }
                if (written == 0) throw new IOException("Protocol output pipe closed without accepting data.");
                offset += checked((int)written);
            }
        }
        finally { pinned.Free(); }
    }
    private static string Quote(string arg)
    {
        // Windows CommandLineToArgvW/CRT escaping. Always quote, preserving empty
        // arguments and exact backslash/quote sequences; no shell is involved.
        var b = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); }
            else { b.Append('\\', slashes); b.Append(c); }
            slashes = 0;
        }
        b.Append('\\', slashes * 2); b.Append('"');
        return b.ToString();
    }
    public static int Main(string[] args)
    {
        Console.InputEncoding = Utf8;
        Console.OutputEncoding = Utf8;
        if (args.Length == 1 && args[0] == "--bridge-self-test") return SelfTest();
        try
        {
            string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string target = File.ReadAllText(Path.Combine(directory, "codex-real-path.txt"), Utf8).Trim();
            if (!Path.IsPathRooted(target) || !File.Exists(target)) throw new InvalidOperationException("codex-real-path.txt must contain an existing absolute native Codex executable path.");
            if (String.Equals(Path.GetFullPath(target), Assembly.GetExecutingAssembly().Location, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Bridge target must not be the bridge itself.");
            bool filter = Array.IndexOf(args, "app-server") >= 0;
            return Relay(target, args, filter);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[AionUi Codex bridge] " + ex.Message);
            return 1;
        }
    }
    private static int Relay(string target, string[] args, bool filterEnabled)
    {
        var encodedArgs = new List<string>();
        foreach (var arg in args) encodedArgs.Add(Quote(arg));
        var start = new ProcessStartInfo(target, String.Join(" ", encodedArgs));
        start.UseShellExecute = false;
        // Intentionally retain the platform's default process/console flags.
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.StandardOutputEncoding = Utf8;
        start.StandardErrorEncoding = Utf8;
        using (var child = Process.Start(start))
        {
            if (!filterEnabled)
            {
                // Version/help/other CLI invocations retain byte-stream behavior.
                Task.Run(async delegate { try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); child.StandardInput.Close(); } catch (IOException) { } });
                var stdout = Task.Run(async delegate { await child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput()); });
                var stderr = Task.Run(async delegate { await child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError()); });
                child.WaitForExit();
                Task.WaitAll(stdout, stderr);
                return child.ExitCode;
            }
            var policy = new ThreadNotificationFilter();
            var stdin = new StreamWriter(child.StandardInput.BaseStream, Utf8) { AutoFlush = true };
            Task.Run(delegate
            {
                try
                {
                    string line;
                    while ((line = Console.ReadLine()) != null) { policy.ClientLine(line); stdin.WriteLine(line); }
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                finally { try { stdin.Close(); } catch (IOException) { } catch (ObjectDisposedException) { } }
            });
            IntPtr standardOutput = GetStdHandle(-11);
            var outputTask = Task.Run(delegate
            {
                try
                {
                    string line;
                    while ((line = child.StandardOutput.ReadLine()) != null)
                        foreach (var output in policy.ServerLine(line)) WriteProtocolLine(standardOutput, output);
                    foreach (var output in policy.EndOfStream()) WriteProtocolLine(standardOutput, output);
                }
                catch (IOException)
                {
                    // The host closed the protocol pipe: retaining a live native
                    // app-server would leave it unable to deliver its result.
                    try { if (!child.HasExited) child.Kill(); } catch (InvalidOperationException) { }
                }
            });
            var errorTask = Task.Run(async delegate
            {
                bool discardRemainder = false;
                try { await child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError()); }
                catch (IOException) { discardRemainder = true; }
                if (discardRemainder) await child.StandardError.BaseStream.CopyToAsync(Stream.Null);
            });
            child.WaitForExit();
            Task.WaitAll(outputTask, errorTask);
            if (policy.CompatibilityFallbacks > 0) Console.Error.WriteLine("[AionUi Codex bridge] Unrecognized root handshake; notification filtering used a compatibility fallback.");
            return child.ExitCode;
        }
    }

    private static void Equal(List<string> actual, params string[] expected)
    {
        if (actual.Count != expected.Length) throw new Exception("Unexpected forwarded frame count: " + actual.Count + " != " + expected.Length);
        for (int i = 0; i < expected.Length; i++) if (actual[i] != expected[i]) throw new Exception("Forwarded frame changed or was reordered.");
    }
    private static string N(string method, string thread) { return "{\"method\":\"" + method + "\",\"params\":{\"threadId\":\"" + thread + "\"}}"; }
    private static int SelfTest()
    {
        try
        {
            var f = new ThreadNotificationFilter();
            const string parentStarted = "{\"method\":\"thread/started\",\"params\":{\"thread\":{\"id\":\"parent\"}}}";
            const string childStarted = "{\"method\":\"thread/started\",\"params\":{\"thread\":{\"id\":\"child\"}}}";
            const string response = "{\"id\":2,\"result\":{\"thread\":{\"id\":\"parent\"}}}";
            f.ClientLine("{\"id\":2,\"method\":\"thread/start\",\"params\":{}}");
            Equal(f.ServerLine(childStarted));
            Equal(f.ServerLine(parentStarted));
            Equal(f.ServerLine(response), parentStarted, response);
            foreach (string method in new[] { "turn/started", "turn/completed", "thread/status/changed", "item/agentMessage/delta", "item/completed", "error", "thread/tokenUsage/updated" })
            {
                string parent = N(method, "parent"); Equal(f.ServerLine(parent), parent);
                Equal(f.ServerLine(N(method, "child")));
            }
            Equal(f.ServerLine(childStarted));
            Equal(f.ServerLine(parentStarted), parentStarted);
            string legacyParent = "{\"method\":\"codex/event/task_complete\",\"params\":{\"conversationId\":\"parent\",\"msg\":{\"type\":\"task_complete\"}}}";
            Equal(f.ServerLine(legacyParent), legacyParent);
            Equal(f.ServerLine(legacyParent.Replace("parent", "child")));
            foreach (string frame in new[] {
                "{\"id\":17,\"result\":{\"threadId\":\"child\"}}",
                "{\"id\":18,\"error\":{\"message\":\"test\"}}",
                "{\"id\":19,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"threadId\":\"child\"}}",
                "{\"method\":\"serverRequest/resolved\",\"params\":{\"threadId\":\"child\",\"requestId\":19}}",
                "{\"method\":\"account/updated\",\"params\":{\"authMode\":\"chatgpt\"}}",
                "{\"method\":\"item/completed\",\"params\":{\"threadId\":\"parent\",\"item\":{\"type\":\"collabAgentToolCall\",\"receiverThreadIds\":[\"child\"]}}}",
                "malformed diagnostic text", "{\"method\":\"future/global\",\"params\":{}}" }) Equal(f.ServerLine(frame), frame);
            var resume = new ThreadNotificationFilter();
            resume.ClientLine("{\"id\":\"resume\",\"method\":\"thread/resume\",\"params\":{\"threadId\":\"parent\"}}");
            Equal(resume.ServerLine(N("turn/completed", "child")));
            Equal(resume.ServerLine(parentStarted), parentStarted);
            var fork = new ThreadNotificationFilter();
            fork.ClientLine("{\"id\":\"fork\",\"method\":\"thread/fork\",\"params\":{\"threadId\":\"source\"}}");
            Equal(fork.ServerLine(N("turn/completed", "source")));
            const string forkReply = "{\"id\":\"fork\",\"result\":{\"thread\":{\"id\":\"parent\"}}}";
            Equal(fork.ServerLine(parentStarted));
            Equal(fork.ServerLine(forkReply), parentStarted, forkReply);
            var unknown = new ThreadNotificationFilter();
            Equal(unknown.ServerLine(N("turn/completed", "parent")), N("turn/completed", "parent"));
            var correlation = new ThreadNotificationFilter();
            correlation.ClientLine("{\"id\":1,\"method\":\"thread/start\",\"params\":{}}");
            const string unrelatedStringId = "{\"id\":\"1\",\"result\":{\"thread\":{\"id\":\"child\"}}}";
            Equal(correlation.ServerLine(unrelatedStringId), unrelatedStringId);
            Equal(correlation.ServerLine(childStarted));
            Equal(correlation.ServerLine(parentStarted));
            const string correlatedNumericId = "{\"id\":1,\"result\":{\"thread\":{\"id\":\"parent\"}}}";
            Equal(correlation.ServerLine(correlatedNumericId), parentStarted, correlatedNumericId);
            Console.WriteLine("PASS: fresh/resume/fork ownership, parent/child turn and task_complete, deltas, errors, global notifications, RPC requests/responses with typed IDs, approvals, collaboration roster, malformed/future frames; JSON line contents unchanged.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine("FAIL: " + ex.Message); return 1; }
    }
}
