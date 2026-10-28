using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
public static class FakeChild {
    public static int Main(string[] args) {
        File.WriteAllText(Environment.GetEnvironmentVariable("REVIEW_PID_PATH"), Process.GetCurrentProcess().Id.ToString());
        var mode = Environment.GetEnvironmentVariable("REVIEW_MODE");
        if(mode == "hold") { Thread.Sleep(60000); return 0; }
        if(mode == "write") {
            while(true) { Console.WriteLine("{\"method\":\"review/global\",\"params\":{}}"); Thread.Sleep(5); }
        }
        var received = Console.OpenStandardInput();
        using(var saved = File.Create(Environment.GetEnvironmentVariable("REVIEW_INPUT_PATH"))) received.CopyTo(saved);
        Console.OpenStandardOutput().Write(new byte[]{0x7b,0x22,0x69,0x64,0x22,0x3a,0x39,0x2c,0x22,0x72,0x65,0x73,0x75,0x6c,0x74,0x22,0x3a,0x7b,0x7d,0x7d,0x0a},0,21);
        Console.Error.Write("REVIEW_STDERR_OK");
        return 23;
    }
}
