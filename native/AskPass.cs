using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// This helper only relays OpenSSH's prompt and response. No secret is written to disk.
internal static class AskPass
{
    private static int Main(string[] args)
    {
        try
        {
            string pipeName = Environment.GetEnvironmentVariable("SCP_FAST_AUTH_PIPE");
            string token = Environment.GetEnvironmentVariable("SCP_FAST_AUTH_TOKEN");
            string hint = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") ?? "";
            if (String.IsNullOrEmpty(pipeName) || String.IsNullOrEmpty(token) || args.Length == 0) return 1;
            if (hint == "none") return 0;
            JavaScriptSerializer json = new JavaScriptSerializer();
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
            {
                pipe.Connect(10000);
                using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
                using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true))
                {
                    writer.AutoFlush = true;
                    writer.WriteLine(json.Serialize(new { token = token, prompt = args[0], hint = hint }));
                    string line = reader.ReadLine();
                    if (line == null) return 1;
                    Dictionary<string, object> answer = json.Deserialize<Dictionary<string, object>>(line);
                    if (answer.ContainsKey("cancelled") && Convert.ToBoolean(answer["cancelled"])) return 1;
                    if (!answer.ContainsKey("value")) return 1;
                    // SSH reads one UTF-8 line from this stdout pipe; stdout is not a log sink.
                    Console.OutputEncoding = new UTF8Encoding(false);
                    Console.WriteLine(Convert.ToString(answer["value"]));
                    return 0;
                }
            }
        }
        catch { return 1; }
    }
}
