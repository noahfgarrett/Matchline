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
            bool keepStream = false;

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

                ThrowIfCancelled();

                string cachePath = Path.Combine(_arguments.CacheDirectory, sha256 + ".sqlite");
                streamPath = Path.Combine(_arguments.CacheDirectory, sha256 + ".ndjson.tmp");
                partialCachePath = cachePath + ".partial";

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

                NavisworksInstall install = LocateNavisworks();
                if (install == null)
                {
                    return Fail(
                        ExtractionErrorCodes.NavisworksNotInstalled,
                        _arguments.NavisworksDirectory == null
                            ? "No licensed Navisworks Manage or Simulate install was found. " +
                              "Extraction requires one on this machine."
                            : "No " + NavisworksLocator.ExecutableName + " under '" +
                              _arguments.NavisworksDirectory + "'.");
                }

                ThrowIfCancelled();
                DeleteIfExists(streamPath);
                DeleteIfExists(partialCachePath);

                _reporter.Progress(ExtractionStages.Open, 0, 1);

                NavisworksRunResult run;
                using (NdjsonProgressMonitor monitor = new NdjsonProgressMonitor(streamPath, _reporter))
                {
                    monitor.Start();
                    run = new NavisworksProcessRunner().Run(
                        install, _arguments.InputPath, streamPath, IsCancelled);
                }

                if (run.WasKilled || _cancelRequested)
                {
                    throw new OperationCanceledException();
                }

                if (!File.Exists(streamPath))
                {
                    // The plugin never wrote anything: either it was not found,
                    // or Navisworks failed before it ran.
                    string code = FailureClassifier.ClassifyMessage(
                        run.CapturedOutput, ExtractionErrorCodes.ExtractFailed);
                    return Fail(
                        code,
                        "Navisworks produced no extraction stream (exit code " +
                        run.ExitCode.ToString(CultureInfo.InvariantCulture) + "). " +
                        FirstLines(run.CapturedOutput, 5));
                }

                _reporter.Progress(ExtractionStages.Convert, 0, 0);

                Dictionary<string, string> launcherMeta = BuildLauncherMeta(inputInfo, sha256);
                ConversionOutcome outcome = ConvertStream(streamPath, partialCachePath, cachePath, launcherMeta);

                if (!outcome.Ok)
                {
                    keepStream = true;
                    string code = outcome.ErrorCode;
                    if (code == ExtractionErrorCodes.ExtractFailed)
                    {
                        // The child's own output may name a better code (a
                        // too-new NWD in particular).
                        code = FailureClassifier.ClassifyMessage(run.CapturedOutput, code);
                    }

                    return Fail(
                        code,
                        outcome.ErrorMessage + " Stream kept for diagnosis at: " + streamPath);
                }

                _reporter.Progress(ExtractionStages.Finalize, 1, 1);
                _reporter.ResultOk(cachePath, outcome.ObjectCount, outcome.WarningCount);
                return ExitCodes.Ok;
            }
            catch (OperationCanceledException)
            {
                return Fail(ExtractionErrorCodes.Cancelled, "Extraction cancelled.");
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
            }
        }

        private NavisworksInstall LocateNavisworks()
        {
            if (!string.IsNullOrEmpty(_arguments.NavisworksDirectory))
            {
                return NavisworksLocator.FromDirectory(_arguments.NavisworksDirectory);
            }

            return NavisworksLocator.FindNewest();
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
