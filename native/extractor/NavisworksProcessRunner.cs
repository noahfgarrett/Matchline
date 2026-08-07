using System;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>Outcome of one headless Navisworks run.</summary>
    internal sealed class NavisworksRunResult
    {
        internal int ExitCode { get; set; }

        /// <summary>True when the launcher killed the process because of a cancel.</summary>
        internal bool WasKilled { get; set; }

        /// <summary>Captured stdout+stderr, bounded. Used only to classify failures.</summary>
        internal string CapturedOutput { get; set; }
    }

    /// <summary>
    /// Starts Navisworks headless, runs the extraction plugin, and waits.
    /// <para>
    /// The worker exits after each extraction, which is how Autodesk memory gets
    /// reclaimed (EXTRACTION.md, design call 3) -- there is no persistent host.
    /// </para>
    /// </summary>
    internal sealed class NavisworksProcessRunner
    {
        /// <summary>How often the wait loop checks for a cancel request.</summary>
        private const int PollIntervalMs = 250;

        /// <summary>Cap on captured child output, to bound memory on a chatty run.</summary>
        private const int MaxCapturedChars = 64 * 1024;

        /// <summary>
        /// Builds the Navisworks command line.
        /// <para>
        /// VERIFY-ON-WINDOWS -- this is the single most uncertain thing in the
        /// whole launcher. The assumed convention is:
        /// </para>
        /// <code>
        /// Roamer.exe "&lt;input&gt;" -NoGUI -ExecuteAddInPlugin MatchlineExtract.MTCH "&lt;ndjson&gt;" "&lt;input&gt;"
        /// </code>
        /// <para>
        /// i.e. the file to open comes first, and everything after the plugin id
        /// is passed to Execute(params string[]). The input path is repeated on
        /// purpose: the plugin uses its copy for meta and for the fallback open.
        /// </para>
        /// <para>
        /// If the plugin never runs, try these variations in order, and record
        /// which one worked:
        /// 1. drop -NoGUI (it may not be a valid switch on this release);
        /// 2. put -NoGUI before the file;
        /// 3. put the file last, after the plugin parameters;
        /// 4. use -OpenFile "&lt;input&gt;" instead of a bare path.
        /// Everything needed lives in this one method.
        /// </para>
        /// </summary>
        internal static string BuildArguments(string inputPath, string ndjsonPath)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(Quote(inputPath));
            builder.Append(" -NoGUI");
            builder.Append(" -ExecuteAddInPlugin ");
            builder.Append(Quote(ExtractionPlugin.CommandLineId));
            builder.Append(' ');
            builder.Append(Quote(ndjsonPath));
            builder.Append(' ');
            builder.Append(Quote(inputPath));
            return builder.ToString();
        }

        internal NavisworksRunResult Run(
            NavisworksInstall install,
            string inputPath,
            string ndjsonPath,
            Func<bool> isCancelled)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = install.ExecutablePath;
            startInfo.Arguments = BuildArguments(inputPath, ndjsonPath);
            startInfo.UseShellExecute = false;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.CreateNoWindow = true;

            // Run from the install folder so Navisworks resolves its own
            // satellite DLLs the way it does when launched normally.
            startInfo.WorkingDirectory = install.InstallDirectory;

            StringBuilder captured = new StringBuilder();
            object captureGate = new object();

            NavisworksRunResult result = new NavisworksRunResult();

            using (Process process = new Process())
            {
                process.StartInfo = startInfo;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    Capture(captured, captureGate, e.Data);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    Capture(captured, captureGate, e.Data);
                };

                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                while (!process.WaitForExit(PollIntervalMs))
                {
                    if (isCancelled != null && isCancelled())
                    {
                        result.WasKilled = true;
                        TryKill(process);
                        break;
                    }
                }

                // The parameterless overload is what guarantees the async output
                // handlers have drained before CapturedOutput is read.
                process.WaitForExit();

                try
                {
                    result.ExitCode = process.ExitCode;
                }
                catch (InvalidOperationException)
                {
                    result.ExitCode = -1;
                }
            }

            lock (captureGate)
            {
                result.CapturedOutput = captured.ToString();
            }

            return result;
        }

        private static void Capture(StringBuilder captured, object gate, string line)
        {
            if (line == null)
            {
                return;
            }

            lock (gate)
            {
                if (captured.Length >= MaxCapturedChars)
                {
                    return;
                }

                captured.Append(line);
                captured.Append('\n');
            }
        }

        private static void TryKill(Process process)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
            }
            catch (InvalidOperationException)
            {
                // Already gone.
            }
            catch (System.ComponentModel.Win32Exception)
            {
                // Access denied or exiting; the wait below settles it either way.
            }

            // Give the process a moment to die before the caller cleans up files
            // it may still have open.
            try
            {
                process.WaitForExit(5000);
            }
            catch (SystemException)
            {
            }
        }

        /// <summary>Windows command-line quoting (backslash-before-quote rules).</summary>
        private static string Quote(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "\"\"";
            }

            StringBuilder builder = new StringBuilder(value.Length + 8);
            builder.Append('"');

            int backslashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (c == '"')
                {
                    builder.Append('\\', (backslashes * 2) + 1);
                    builder.Append('"');
                    backslashes = 0;
                    continue;
                }

                builder.Append('\\', backslashes);
                backslashes = 0;
                builder.Append(c);
            }

            builder.Append('\\', backslashes * 2);
            builder.Append('"');
            return builder.ToString();
        }

        /// <summary>Human-readable command line, for diagnostics only.</summary>
        internal static string DescribeCommand(NavisworksInstall install, string inputPath, string ndjsonPath)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} {1}",
                Quote(install.ExecutablePath),
                BuildArguments(inputPath, ndjsonPath));
        }
    }
}
