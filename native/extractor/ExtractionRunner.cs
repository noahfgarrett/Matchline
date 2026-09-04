using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;
using Matchline.Extraction.Json;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// The extraction pipeline, end to end:
    /// hash -> cache-hit check -> headless Navisworks -> NDJSON -> SQLite ->
    /// atomic rename. Matches the process model in docs/EXTRACTION.md.
    /// </summary>
    internal sealed class ExtractionRunner
    {
        /// <summary>
        /// Warnings forwarded to stdout before falling silent. All of them are
        /// stored in the cache regardless; a model with a million bad properties
        /// must not drown the parent process in protocol lines.
        /// </summary>
        private const int MaxForwardedWarnings = 20;

        /// <summary>Records between convert-stage progress lines.</summary>
        private const int ConvertProgressInterval = 25000;

        private readonly ExtractorArguments _arguments;
        private readonly ProgressReporter _reporter;

        private volatile bool _cancelRequested;
        private long _forwardedWarnings;

        internal ExtractionRunner(ExtractorArguments arguments, ProgressReporter reporter)
        {
            _arguments = arguments;
            _reporter = reporter;
        }

        internal int Run()
        {
            StartCancelListener();

            string streamPath = null;
            string partialCachePath = null;
            string roamerLogPath = null;
            bool keepStream = false;
            bool keepRoamerLog = false;

            try
            {
                if (!File.Exists(_arguments.InputPath))
                {
                    return Fail(
                        ExtractionErrorCodes.InputNotFound,
                        "Input file not found: " + Path.GetFileName(_arguments.InputPath));
                }

                Directory.CreateDirectory(_arguments.CacheDirectory);

                FileInfo inputInfo = new FileInfo(_arguments.InputPath);

                string sha256;
                if (!string.IsNullOrEmpty(_arguments.InputSha256))
                {
                    // The caller hashed these bytes already and said so
                    // (--input-sha256), so this run does not read the file a
                    // second time to learn what it is. Matchline's own app is
                    // the caller that matters: it streams the hash when a model
                    // is registered and will not compile from a file whose
                    // bytes have moved since, so hashing again here was a full
                    // extra read of a multi-gigabyte model for an answer it had
                    // already paid for (docs/RELEASE-1.0-PLAN.md, "Performance
                    // / isolation").
                    //
                    // TRUSTED, not verified: verifying it would be the read it
                    // exists to avoid. The value is what addresses the cache and
                    // what the cache records as its input_sha256, so a caller
                    // that lies gets a cache filed under the wrong name -- which
                    // is why the flag is documented as an assertion and why the
                    // spelling is refused at parse time rather than here.
                    sha256 = _arguments.InputSha256;

                    // The stage is still announced, complete, with the file's
                    // real size: a parent process draws its progress from these
                    // lines, and a run that silently skipped a stage would look
                    // like a run that had stalled before it.
                    _reporter.Progress(ExtractionStages.Hash, inputInfo.Length, inputInfo.Length);
                }
                else
                {
                    try
                    {
                        sha256 = FileHasher.Sha256(_arguments.InputPath, _reporter, IsCancelled);
                    }
                    catch (IOException ex)
                    {
                        // Commonly: the NWD is open in Navisworks and locked. That is
                        // an open failure, not a cache failure.
                        return Fail(ExtractionErrorCodes.OpenFailed, "Could not read the input file: " + ex.Message);
                    }
                    catch (UnauthorizedAccessException ex)
                    {
                        return Fail(ExtractionErrorCodes.OpenFailed, "Could not read the input file: " + ex.Message);
                    }
                }

                ThrowIfCancelled();

                string cachePath = Path.Combine(_arguments.CacheDirectory, sha256 + ".sqlite");
                streamPath = Path.Combine(_arguments.CacheDirectory, sha256 + ".ndjson.tmp");
                partialCachePath = cachePath + ".partial";

                // Navisworks's own log for this run. It is the only place a GUI
                // executable says anything about a failure -- nothing reaches
                // the stdout the launcher captures -- so it is kept whenever the
                // run fails and deleted whenever it does not.
                roamerLogPath = Path.Combine(_arguments.CacheDirectory, sha256 + ".roamer.log");

                CacheValidation existing = CacheInspector.Validate(cachePath);
                if (existing.IsValid)
                {
                    _reporter.ResultCacheHit(cachePath, existing.ObjectCount, existing.WarningCount);
                    return ExitCodes.Ok;
                }

                if (File.Exists(cachePath))
                {
                    // Present but not trustworthy: say so and re-extract rather
                    // than silently serving a bad cache.
                    _reporter.Warning("STALE_CACHE_DISCARDED", existing.Reason, null);
                    File.Delete(cachePath);
                }

                string locateFailure;
                NavisworksInstall install = LocateNavisworks(out locateFailure);
                if (install == null)
                {
                    return Fail(ExtractionErrorCodes.NavisworksNotInstalled, locateFailure);
                }

                // Before Navisworks is started, not after: a missing add-in
                // produces either no stream at all or an invisible message box,
                // and neither of those failures is about the model or fixable by
                // adding the file again (the audit's B2). It also comes before
                // the detect line so that line can name the add-in it found --
                // which of the two Plugins roots Navisworks honours is one of
                // the things the first proof run is there to settle
                // (docs/WINDOWS-RUNBOOK.md).
                string pluginPath;
                string pluginSearched;
                if (!PluginDeployment.IsDeployed(install, out pluginPath, out pluginSearched))
                {
                    return Fail(
                        ExtractionErrorCodes.PluginNotDeployed,
                        PluginDeployment.DescribeMissing(install, pluginSearched));
                }

                ReportDetected(install, pluginPath);

                ThrowIfCancelled();
                DeleteIfExists(streamPath);
                DeleteIfExists(partialCachePath);

                _reporter.Progress(ExtractionStages.Open, 0, 1);

                DeleteIfExists(roamerLogPath);

                NavisworksRunResult run;
                using (NdjsonProgressMonitor monitor = new NdjsonProgressMonitor(streamPath, _reporter))
                {
                    monitor.Start();
                    run = new NavisworksProcessRunner().Run(
                        install,
                        _arguments.InputPath,
                        streamPath,
                        roamerLogPath,
                        IsCancelled,
                        monitor,
                        _arguments.StallTimeoutSeconds);
                }

                if (!string.IsNullOrEmpty(run.JobObjectFailure))
                {
                    // Never fatal: the run is fine, it just has no operating
                    // system backstop if this launcher is killed outright.
                    _reporter.Warning(
                        "JOB_OBJECT_UNAVAILABLE",
                        "Windows would not let Matchline tie the Navisworks process to this run (" +
                        run.JobObjectFailure + "). The extraction is unaffected, but if Matchline " +
                        "is force-quit, Navisworks may keep running in the background.",
                        null);
                }

                if (run.WasKilled || _cancelRequested)
                {
                    throw new OperationCanceledException();
                }

                if (run.WasStalled)
                {
                    keepRoamerLog = true;
                    return Fail(
                        ExtractionErrorCodes.NavisworksStalled,
                        "Navisworks stopped responding: nothing was written to the extraction " +
                        "stream for " +
                        _arguments.StallTimeoutSeconds.ToString(CultureInfo.InvariantCulture) +
                        " seconds, so it was stopped. A headless Navisworks that goes quiet is " +
                        "usually waiting on a dialog nobody can see. " +
                        DescribeRoamerLog(roamerLogPath) + " " +
                        FirstLines(run.CapturedOutput, 5));
                }

                if (!File.Exists(streamPath))
                {
                    // Navisworks ran and the plugin never wrote a byte: either
                    // the add-in was not loaded, or Navisworks failed before it
                    // reached it. PLUGIN_NOT_FOUND rather than EXTRACT_FAILED,
                    // which is a stream that started and did not finish -- the
                    // two need different sentences and different fixes.
                    keepRoamerLog = true;
                    string code = FailureClassifier.ClassifyMessage(
                        run.CapturedOutput, ExtractionErrorCodes.PluginNotFound);
                    return Fail(
                        code,
                        "Navisworks produced no extraction stream (exit code " +
                        run.ExitCode.ToString(CultureInfo.InvariantCulture) + "). " +
                        DescribeRoamerLog(roamerLogPath) + " " +
                        FirstLines(run.CapturedOutput, 5));
                }

                _reporter.Progress(ExtractionStages.Convert, 0, 0);

                Dictionary<string, string> launcherMeta = BuildLauncherMeta(inputInfo, sha256);
                ConversionOutcome outcome = ConvertStream(streamPath, partialCachePath, cachePath, launcherMeta);

                if (!outcome.Ok)
                {
                    keepStream = true;
                    keepRoamerLog = true;
                    string code = outcome.ErrorCode;
                    if (code == ExtractionErrorCodes.ExtractFailed)
                    {
                        // The child's own output may name a better code (a
                        // too-new NWD in particular).
                        code = FailureClassifier.ClassifyMessage(run.CapturedOutput, code);
                    }

                    return Fail(
                        code,
                        outcome.ErrorMessage + " Stream kept for diagnosis at: " + streamPath + ". " +
                        DescribeRoamerLog(roamerLogPath));
                }

                _reporter.Progress(ExtractionStages.Finalize, 1, 1);
                _reporter.ResultOk(cachePath, outcome.ObjectCount, outcome.WarningCount);
                return ExitCodes.Ok;
            }
            catch (OperationCanceledException)
            {
                return Fail(ExtractionErrorCodes.Cancelled, "Extraction cancelled.");
            }
            catch (Microsoft.Data.Sqlite.SqliteException ex)
            {
                // A full disk, a read-only cache directory or a database locked
                // by something else all arrive here rather than as IOException:
                // SQLite reports its own errors. Reporting them as INTERNAL made
                // "the disk is full" read as a bug in Matchline.
                keepStream = true;
                keepRoamerLog = true;
                return Fail(
                    ExtractionErrorCodes.CacheWriteFailed,
                    "The cache database could not be written: " + ex.Message);
            }
            catch (IOException ex)
            {
                keepStream = true;
                return Fail(ExtractionErrorCodes.CacheWriteFailed, ex.Message);
            }
            catch (UnauthorizedAccessException ex)
            {
                keepStream = true;
                return Fail(ExtractionErrorCodes.CacheWriteFailed, ex.Message);
            }
            catch (Exception ex)
            {
                keepStream = true;
                return Fail(ExtractionErrorCodes.Internal, ex.GetType().Name + ": " + ex.Message);
            }
            finally
            {
                // The partial cache never survives: a killed, cancelled, or
                // crashed run must leave nothing that looks like a valid cache
                // (Phase 1 exit criterion). The NDJSON stream is kept only when
                // it is the evidence for a failure.
                DeleteIfExists(partialCachePath);
                if (!keepStream)
                {
                    DeleteIfExists(streamPath);
                }

                // Navisworks's log is evidence for a failure and litter after a
                // success, and it is written on every run, so it is deleted here
                // rather than left to accumulate one file per extraction.
                if (!keepRoamerLog)
                {
                    DeleteIfExists(roamerLogPath);
                }
            }
        }

        /// <summary>
        /// Picks the Navisworks that will open this file, or explains why there
        /// is none.
        /// <para>
        /// The three failures are deliberately different sentences: nothing
        /// installed, something installed but no adapter for it, and the
        /// specific year that was asked for not being installed. "Install
        /// Navisworks" and "install a different Navisworks" are different jobs
        /// for the person reading the message.
        /// </para>
        /// </summary>
        private NavisworksInstall LocateNavisworks(out string failureMessage)
        {
            failureMessage = null;

            if (!string.IsNullOrEmpty(_arguments.NavisworksDirectory))
            {
                // An explicit folder is the escape hatch for a non-default
                // install, so it is trusted about *where*. It is still checked
                // about *which*: a year with no adapter cannot open the file
                // usefully, and the deployed plugin would not be there anyway.
                NavisworksInstall chosen = NavisworksLocator.FromDirectory(_arguments.NavisworksDirectory);
                if (chosen == null)
                {
                    failureMessage = "No " + NavisworksLocator.ExecutableName + " under '" +
                        _arguments.NavisworksDirectory + "'.";
                    return null;
                }

                if (chosen.Year != NavisworksLocator.UnknownYear && !chosen.IsSupported)
                {
                    failureMessage = chosen.Describe() +
                        " is installed there, but Matchline has no adapter for that release. " +
                        "Adapters exist for " + SupportedAdapters.YearList() + ".";
                    return null;
                }

                return chosen;
            }

            List<NavisworksInstall> installs = NavisworksLocator.FindAll();
            if (installs.Count == 0)
            {
                failureMessage = "No licensed Navisworks Manage or Simulate install was found. " +
                    "Extraction requires one on this machine.";
                return null;
            }

            if (_arguments.NavisworksYear.HasValue)
            {
                // Parsing already guaranteed this is a year with an adapter, so
                // the only way to get here is that it is not installed.
                int year = _arguments.NavisworksYear.Value;
                NavisworksInstall chosen = NavisworksLocator.SelectYear(installs, year);
                if (chosen == null)
                {
                    failureMessage = "Navisworks " + year.ToString(CultureInfo.InvariantCulture) +
                        " was requested with --navisworks-version but is not installed. Found: " +
                        NavisworksLocator.DescribeAll(installs) + ".";
                    return null;
                }

                return chosen;
            }

            NavisworksInstall newest = NavisworksLocator.SelectNewestSupported(installs);
            if (newest == null)
            {
                failureMessage = "Navisworks is installed, but not a release Matchline has an adapter for. " +
                    "Found: " + NavisworksLocator.DescribeAll(installs) + ". " +
                    "Adapters exist for " + SupportedAdapters.YearList() + ".";
                return null;
            }

            return newest;
        }

        /// <summary>
        /// Names the install that will open the file, and says plainly how far
        /// that adapter has actually been proven.
        /// <para>
        /// Both halves matter. The detect line makes a run unambiguous about
        /// which version produced the cache; the warning keeps the launcher from
        /// implying support it has not earned (docs/RELEASE-1.0-PLAN.md: never
        /// advertise unverified versions). It goes quiet by itself when
        /// SupportedAdapters records a year as verified.
        /// </para>
        /// </summary>
        /// <param name="pluginPath">
        /// The add-in DLL the pre-flight found, or null when the check could not
        /// be made. Named in the detect line because "which Plugins folder was
        /// this loaded from" is a question the proof run has to answer and
        /// nothing else records the answer.
        /// </param>
        private void ReportDetected(NavisworksInstall install, string pluginPath)
        {
            AdapterSupport adapter = install.Adapter;
            string foundAt = string.IsNullOrEmpty(pluginPath)
                ? string.Empty
                : " Add-in found at " + pluginPath + ".";

            if (adapter == null)
            {
                // Only reachable through --navisworks-dir pointing at a folder
                // whose name carries no year.
                _reporter.Progress(
                    ExtractionStages.Detect,
                    1,
                    1,
                    install.Describe() + " will open this file; its release year could not be read from the " +
                    "folder name, so the adapter version cannot be confirmed.");

                _reporter.Warning(
                    "ADAPTER_VERSION_UNKNOWN",
                    "Matchline cannot tell which Navisworks release '" + install.InstallDirectory +
                    "' is. The extraction will use whichever Matchline adapter is deployed there.",
                    null);
                return;
            }

            _reporter.Progress(
                ExtractionStages.Detect,
                1,
                1,
                install.Describe() + " will open this file; expecting adapter " +
                adapter.AdapterVersion + "." + foundAt);

            if (!adapter.IsVerified)
            {
                _reporter.Warning(
                    "ADAPTER_UNVERIFIED",
                    "The " + adapter.AdapterVersion + " adapter is " + adapter.VerificationStatus +
                    ": it has not been proven against a real Navisworks " +
                    install.Year.ToString(CultureInfo.InvariantCulture) + " install yet.",
                    null);
            }
        }

        private Dictionary<string, string> BuildLauncherMeta(FileInfo inputInfo, string sha256)
        {
            Dictionary<string, string> meta = new Dictionary<string, string>(StringComparer.Ordinal);
            meta[CacheMetaKeys.SchemaVersion] = CacheMetaKeys.CurrentSchemaVersion;

            // File name only, never the directory (EXTRACTION.md, confidentiality).
            meta[CacheMetaKeys.InputFileName] = inputInfo.Name;
            meta[CacheMetaKeys.InputSha256] = sha256;
            meta[CacheMetaKeys.InputBytes] = inputInfo.Length.ToString(CultureInfo.InvariantCulture);
            meta[CacheMetaKeys.ExtractedAtUtc] = DateTime.UtcNow.ToString(
                "yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            meta[CacheMetaKeys.ExtractorVersion] = ExtractorVersion();
            return meta;
        }

        private static string ExtractorVersion()
        {
            Version version = Assembly.GetExecutingAssembly().GetName().Version;
            return version == null ? "0.0.0" : version.ToString(3);
        }

        private ConversionOutcome ConvertStream(
            string streamPath,
            string partialCachePath,
            string cachePath,
            IDictionary<string, string> launcherMeta)
        {
            Dictionary<string, string> meta = new Dictionary<string, string>(StringComparer.Ordinal);
            EndRecord end = null;
            long records = 0;
            long warningRows;

            using (CacheWriter writer = CacheWriter.Create(partialCachePath))
            using (NdjsonReader reader = NdjsonReader.OpenFile(streamPath))
            {
                try
                {
                    while (true)
                    {
                        NdjsonEntry entry = reader.ReadNext();
                        if (entry == null)
                        {
                            break;
                        }

                        records++;

                        if (entry.End != null)
                        {
                            end = entry.End;
                            break;
                        }

                        Apply(writer, entry, meta);

                        if ((records % ConvertProgressInterval) == 0)
                        {
                            _reporter.Progress(ExtractionStages.Convert, records, 0);
                            ThrowIfCancelled();
                        }
                    }
                }
                catch (JsonParseException ex)
                {
                    // A stream truncated mid-line is exactly what a killed
                    // plugin leaves behind.
                    return ConversionOutcome.Failure(
                        ExtractionErrorCodes.ExtractFailed,
                        "The extraction stream is truncated or malformed: " + ex.Message);
                }

                if (end == null)
                {
                    return ConversionOutcome.Failure(
                        ExtractionErrorCodes.ExtractFailed,
                        "The extraction stream ended without a terminator; the plugin did not run to completion.");
                }

                if (!end.Ok)
                {
                    return ConversionOutcome.Failure(
                        string.IsNullOrEmpty(end.Code) ? ExtractionErrorCodes.ExtractFailed : end.Code,
                        string.IsNullOrEmpty(end.Message) ? "The extraction plugin reported a failure." : end.Message);
                }

                // Launcher meta is authoritative: it knows the real file, its
                // hash and its size; the plugin only knows what it was told.
                foreach (KeyValuePair<string, string> pair in launcherMeta)
                {
                    meta[pair.Key] = pair.Value;
                }

                warningRows = writer.CountWarnings();

                try
                {
                    writer.Commit(partialCachePath, cachePath, meta, end.ObjectCount);
                }
                catch (CacheIntegrityException ex)
                {
                    return ConversionOutcome.Failure(ExtractionErrorCodes.CacheWriteFailed, ex.Message);
                }
            }

            return ConversionOutcome.Success(end.ObjectCount, warningRows);
        }

        private void Apply(CacheWriter writer, NdjsonEntry entry, IDictionary<string, string> meta)
        {
            if (entry.Meta != null)
            {
                if (!string.IsNullOrEmpty(entry.Meta.Key))
                {
                    meta[entry.Meta.Key] = entry.Meta.Value ?? string.Empty;
                }

                return;
            }

            if (entry.SourceModel != null)
            {
                writer.WriteSourceModel(entry.SourceModel);
                return;
            }

            if (entry.Object != null)
            {
                writer.WriteObject(entry.Object);
                return;
            }

            if (entry.Property != null)
            {
                writer.WriteProperty(entry.Property);
                return;
            }

            if (entry.SelectionSet != null)
            {
                writer.WriteSelectionSet(entry.SelectionSet);
                return;
            }

            if (entry.SelectionSetMember != null)
            {
                writer.WriteSelectionSetMember(entry.SelectionSetMember);
                return;
            }

            if (entry.Warning != null)
            {
                writer.WriteWarning(entry.Warning);
                if (_forwardedWarnings < MaxForwardedWarnings)
                {
                    _forwardedWarnings++;
                    _reporter.Warning(entry.Warning.Code, entry.Warning.Message, entry.Warning.ObjectId);
                }

                return;
            }

            if (entry.Progress != null)
            {
                // Not a cache row: it was already relayed live by
                // NdjsonProgressMonitor while the plugin was running. Re-emitting
                // it here would report a stage as in progress after it finished.
                return;
            }

            // Unknown record type from a newer adapter: ignored on purpose.
        }

        private int Fail(string code, string message)
        {
            _reporter.Error(code, message);
            return ExitCodes.ForErrorCode(code);
        }

        private void StartCancelListener()
        {
            Thread thread = new Thread(CancelListenerLoop);
            thread.IsBackground = true;
            thread.Name = "matchline-stdin-cancel";
            thread.Start();
        }

        private void CancelListenerLoop()
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null)
                    {
                        // End of stdin. When it was redirected, the only thing
                        // on the other end was the parent process, and its
                        // going away is a cancel nobody got to send: carrying on
                        // would leave a headless Navisworks running for a result
                        // nobody will ever read. A console run has a
                        // non-redirected stdin and never reaches EOF this way,
                        // so running the launcher by hand is unaffected.
                        if (Console.IsInputRedirected)
                        {
                            _cancelRequested = true;
                        }

                        return;
                    }

                    if (string.Equals(line.Trim(), "cancel", StringComparison.OrdinalIgnoreCase))
                    {
                        _cancelRequested = true;
                        return;
                    }
                }
            }
            catch (IOException)
            {
                // stdin closed; nothing to listen to.
            }
            catch (ObjectDisposedException)
            {
            }
        }

        private bool IsCancelled()
        {
            return _cancelRequested;
        }

        private void ThrowIfCancelled()
        {
            if (_cancelRequested)
            {
                throw new OperationCanceledException();
            }
        }

        private static void DeleteIfExists(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return;
            }

            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (IOException)
            {
                // Best effort: a locked temp file is not worth failing a run over.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        /// <summary>
        /// Names Navisworks's own log when there is one, so a person reporting
        /// a failure has the file to send. Empty when Navisworks wrote nothing.
        /// </summary>
        private static string DescribeRoamerLog(string logPath)
        {
            if (string.IsNullOrEmpty(logPath) || !File.Exists(logPath))
            {
                return string.Empty;
            }

            return "Navisworks kept its own log at: " + logPath + ".";
        }

        private static string FirstLines(string text, int count)
        {
            if (string.IsNullOrEmpty(text))
            {
                return string.Empty;
            }

            string[] lines = text.Split('\n');
            int take = Math.Min(count, lines.Length);
            return string.Join(" / ", lines, 0, take).Trim();
        }

        private sealed class ConversionOutcome
        {
            internal bool Ok { get; private set; }

            internal string ErrorCode { get; private set; }

            internal string ErrorMessage { get; private set; }

            internal long ObjectCount { get; private set; }

            internal long WarningCount { get; private set; }

            internal static ConversionOutcome Success(long objectCount, long warningCount)
            {
                ConversionOutcome outcome = new ConversionOutcome();
                outcome.Ok = true;
                outcome.ObjectCount = objectCount;
                outcome.WarningCount = warningCount;
                return outcome;
            }

            internal static ConversionOutcome Failure(string code, string message)
            {
                ConversionOutcome outcome = new ConversionOutcome();
                outcome.Ok = false;
                outcome.ErrorCode = code;
                outcome.ErrorMessage = message;
                return outcome;
            }
        }
    }
}
