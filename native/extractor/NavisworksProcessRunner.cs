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

        /// <summary>
        /// True when the launcher killed the process because it had stopped
        /// writing anything for longer than the stall timeout.
        /// </summary>
        internal bool WasStalled { get; set; }

        /// <summary>Captured stdout+stderr, bounded. Used only to classify failures.</summary>
        internal string CapturedOutput { get; set; }

        /// <summary>
        /// Why this run has no job object, or null when it has one. Reported as
        /// a warning, never as a failure.
        /// </summary>
        internal string JobObjectFailure { get; set; }
    }

    /// <summary>
    /// Starts Navisworks headless, runs the extraction plugin, and waits.
    /// <para>
    /// The worker exits after each extraction, which is how Autodesk memory gets
    /// reclaimed (EXTRACTION.md, design call 3) -- there is no persistent host.
    /// </para>
    /// <para>
    /// Three things end the wait besides Roamer exiting on its own, and each is
    /// a different fact:
    /// </para>
    /// <list type="bullet">
    /// <item>a cancel request, which is the user;</item>
    /// <item>the terminator record appearing in the stream, after which Roamer
    /// gets a short grace period and is then killed -- the extraction is
    /// complete and a GUI executable that will not close is nobody's
    /// problem;</item>
    /// <item>the stream not growing for the stall timeout, which on a headless
    /// desktop nearly always means a modal dialog nobody can see.</item>
    /// </list>
    /// </summary>
    internal sealed class NavisworksProcessRunner
    {
        /// <summary>How often the wait loop checks for a cancel request.</summary>
        private const int PollIntervalMs = 250;

        /// <summary>Cap on captured child output, to bound memory on a chatty run.</summary>
        private const int MaxCapturedChars = 64 * 1024;

        /// <summary>
        /// How long Roamer gets to exit by itself after the stream is complete.
        /// <para>
        /// Half a minute is enough for an orderly Navisworks shutdown (it
        /// flushes, releases the licence and closes the document) and short
        /// enough that a Navisworks which is never going to exit does not hold
        /// the serial queue behind a run whose cache is already written.
        /// </para>
        /// </summary>
        private const int EndRecordGraceSeconds = 30;

        /// <summary>
        /// How long the runner waits for a killed process to actually go.
        /// <para>
        /// Bounded, unlike <c>WaitForExit()</c> with no argument: the
        /// parameterless overload also waits for the redirected output handlers
        /// to drain, and a grandchild Roamer left holding the pipe would hang
        /// the launcher forever on a wait that exists only to tidy up.
        /// </para>
        /// </summary>
        private const int ExitWaitMs = 5000;

        /// <summary>
        /// Builds the Navisworks command line.
        /// <para>
        /// VERIFY-ON-WINDOWS -- this is the single most uncertain thing in the
        /// whole launcher. The assumed convention is:
        /// </para>
        /// <code>
        /// Roamer.exe "&lt;input&gt;" -NoGUI -log "&lt;log&gt;" -ExecuteAddInPlugin MatchlineExtract.MTCH "&lt;ndjson&gt;" "&lt;input&gt;"
        /// </code>
        /// <para>
        /// i.e. the file to open comes first, and everything after the plugin id
        /// is passed to Execute(params string[]). The input path is repeated on
        /// purpose: the plugin uses its copy for meta and for the fallback open.
        /// </para>
        /// <para>
        /// VERIFY-ON-WINDOWS (-log): the switch is documented for Navisworks's
        /// command-line utilities and is assumed to be accepted by Roamer, where
        /// it writes Navisworks's own diagnostic log. It is the only channel
        /// that can say anything about a run that produced no stream -- a GUI
        /// executable writes nothing to the stdout the launcher captures. If
        /// Roamer refuses the switch, drop this one argument first; nothing else
        /// depends on it, and <paramref name="logPath"/> being null already
        /// omits it.
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
        internal static string BuildArguments(string inputPath, string ndjsonPath, string logPath)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(Quote(inputPath));
            builder.Append(" -NoGUI");
            if (!string.IsNullOrEmpty(logPath))
            {
                builder.Append(" -log ");
                builder.Append(Quote(logPath));
            }

            builder.Append(" -ExecuteAddInPlugin ");
            builder.Append(Quote(ExtractionPlugin.CommandLineId));
            builder.Append(' ');
            builder.Append(Quote(ndjsonPath));
            builder.Append(' ');
            builder.Append(Quote(inputPath));
            return builder.ToString();
        }

        /// <param name="progress">
        /// The stream monitor for this run. It is what knows whether the plugin
        /// has finished and whether the stream is still growing, so the wait
        /// loop asks it rather than stat-ing the file a second time.
        /// </param>
        /// <param name="stallTimeoutSeconds">Seconds of silence before giving up; 0 never gives up.</param>
        internal NavisworksRunResult Run(
            NavisworksInstall install,
            string inputPath,
            string ndjsonPath,
            string logPath,
            Func<bool> isCancelled,
            NdjsonProgressMonitor progress,
            int stallTimeoutSeconds)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = install.ExecutablePath;
            startInfo.Arguments = BuildArguments(inputPath, ndjsonPath, logPath);
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

            // Created before the process and disposed after it, so the window in
            // which a killed launcher could orphan a Navisworks is only the few
            // instructions between Start() and TryAssign().
            string jobFailure;
            RoamerJob job = RoamerJob.TryCreate(out jobFailure);
            try
            {
                result.JobObjectFailure = jobFailure;

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

                    if (job != null)
                    {
                        // Process.Handle itself throws once a process has been
                        // released, which a Roamer that died on the first
                        // instruction can already have done. That is not a job
                        // failure worth stopping for either.
                        try
                        {
                            string assignFailure;
                            if (!job.TryAssign(process.Handle, out assignFailure))
                            {
                                result.JobObjectFailure = assignFailure;
                            }
                        }
                        catch (InvalidOperationException ex)
                        {
                            result.JobObjectFailure = ex.Message;
                        }
                    }

                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    Wait(process, isCancelled, progress, stallTimeoutSeconds, result);

                    // Bounded on purpose (see ExitWaitMs): the cost is that the
                    // last few lines of captured output may be missing, and that
                    // output is only ever used to classify a failure.
                    process.WaitForExit(ExitWaitMs);

                    try
                    {
                        result.ExitCode = process.ExitCode;
                    }
                    catch (InvalidOperationException)
                    {
                        result.ExitCode = -1;
                    }
                }
            }
            finally
            {
                // Closing the job is what kills anything still inside it, so a
                // Roamer that survived the kill above does not survive this.
                if (job != null)
                {
                    job.Dispose();
                }
            }

            lock (captureGate)
            {
                result.CapturedOutput = captured.ToString();
            }

            return result;
        }

        /// <summary>
        /// Waits for Roamer, and decides when not to wait any more.
        /// <para>
        /// "Still moving" is the stream growing or a plugin-side progress record
        /// arriving -- the two things the monitor can see from outside the
        /// Navisworks process. Neither changing for the whole stall window is
        /// the signal, and it is deliberately not "no CPU" or "no window":
        /// Navisworks sitting on a modal dialog is perfectly busy.
        /// </para>
        /// </summary>
        private static void Wait(
            Process process,
            Func<bool> isCancelled,
            NdjsonProgressMonitor progress,
            int stallTimeoutSeconds,
            NavisworksRunResult result)
        {
            // Stopwatch rather than DateTime: a fifteen-minute window measured
            // against the wall clock moves when the wall clock does, and a
            // machine that syncs its time mid-run would kill a healthy
            // Navisworks or fail to kill a hung one.
            Stopwatch sinceAdvance = Stopwatch.StartNew();
            Stopwatch sinceEndRecord = null;
            long lastBytes = -1;
            int lastProgressLines = -1;

            TimeSpan endGrace = TimeSpan.FromSeconds(EndRecordGraceSeconds);
            TimeSpan stallWindow = TimeSpan.FromSeconds(stallTimeoutSeconds);

            while (!process.WaitForExit(PollIntervalMs))
            {
                if (isCancelled != null && isCancelled())
                {
                    result.WasKilled = true;
                    TryKill(process);
                    return;
                }

                if (progress == null)
                {
                    continue;
                }

                long bytes = progress.BytesSeen;
                int lines = progress.ProgressLinesSeen;
                if (bytes != lastBytes || lines != lastProgressLines)
                {
                    lastBytes = bytes;
                    lastProgressLines = lines;
                    sinceAdvance.Restart();
                }

                if (sinceEndRecord == null && progress.EndRecordSeen)
                {
                    sinceEndRecord = Stopwatch.StartNew();
                }

                if (sinceEndRecord != null)
                {
                    // The stream is complete. Whatever Roamer is doing now, the
                    // extraction is not waiting on it -- and after the grace
                    // period neither is the launcher.
                    if (sinceEndRecord.Elapsed >= endGrace)
                    {
                        TryKill(process);
                        return;
                    }

                    continue;
                }

                if (stallTimeoutSeconds > 0 && sinceAdvance.Elapsed >= stallWindow)
                {
                    result.WasStalled = true;
                    TryKill(process);
                    return;
                }
            }
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
            // it may still have open. Bounded: a kill that did not take must
            // fail the run rather than hang it.
            try
            {
                process.WaitForExit(ExitWaitMs);
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
        internal static string DescribeCommand(
            NavisworksInstall install, string inputPath, string ndjsonPath, string logPath)
        {
            return string.Format(
                CultureInfo.InvariantCulture,
                "{0} {1}",
                Quote(install.ExecutablePath),
                BuildArguments(inputPath, ndjsonPath, logPath));
        }
    }
}
