using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Matchline.Extraction.Extractor;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;
using Microsoft.Data.Sqlite;

namespace Matchline.Extraction.Smoke
{
    /// <summary>
    /// Exercises the Autodesk-free half of the extraction pipeline for real:
    /// synthetic records -> NdjsonWriter -> file -> NdjsonReader -> CacheWriter
    /// -> SQLite -> CacheInspector.
    /// <para>
    /// All data here is invented, following the same rule as the Dragon fixture
    /// in packages/model-schema/src/fixtures/dragon.ts: an imaginary site, no
    /// real tags, no real file names. Nothing in this file may ever be replaced
    /// with anything derived from a client model (docs/EXTRACTION.md,
    /// confidentiality). It is a different shape from Dragon on purpose --
    /// Dragon exercises the TypeScript reader against a TypeScript-written
    /// cache, this exercises it against a C#-written one, and the two should not
    /// be able to drift into agreeing only with themselves.
    /// </para>
    /// <para>
    /// Deterministic apart from <c>extracted_at_utc</c>, which comes from the
    /// clock exactly as ExtractionRunner supplies it.
    /// </para>
    /// <para>
    /// Exit code 0 = every check passed. 1 = at least one failed, and every
    /// failure is printed. The final cache path is printed as
    /// <c>CACHE_PATH=...</c> so the TypeScript cross-check can pick it up.
    /// </para>
    /// </summary>
    internal static class Program
    {
        private static int _checks;
        private static readonly List<string> Failures = new List<string>();

        internal static int Main(string[] args)
        {
            string outputDirectory = args.Length > 0 && !string.IsNullOrEmpty(args[0])
                ? args[0]
                : Path.Combine(Path.GetTempPath(), "matchline-extraction-smoke");

            Directory.CreateDirectory(outputDirectory);

            string streamPath = Path.Combine(outputDirectory, "synthetic.ndjson");
            string partialPath = Path.Combine(outputDirectory, "synthetic.sqlite.partial");
            string cachePath = Path.Combine(outputDirectory, "synthetic.sqlite");

            Delete(streamPath);
            Delete(partialPath);
            Delete(cachePath);

            try
            {
                CheckSchemaIsVerbatim();
                CheckSupportedAdapterTable();
                CheckWarningCollector();
                CheckProgressLineSniffing();
                CheckExtractionSession(outputDirectory);
                CheckAdapterSelection();
                CheckVersionArgument();
                CheckInputShaArgument();

                List<StreamItem> expected = BuildSyntheticStream();
                WriteStream(streamPath, expected);
                List<StreamItem> actual = ReadStream(streamPath);

                CompareStreams(expected, actual);
                CheckWarningsFollowTheirObject(actual);

                long objectCount = CountKind(expected, ItemKind.Object);
                BuildCache(actual, partialPath, cachePath, objectCount);

                CheckCacheContents(cachePath, expected);
                CheckReferentialIntegrity(cachePath);
                CheckInspectorAcceptsIt(cachePath, objectCount);
            }
            catch (Exception ex)
            {
                Failures.Add("unhandled exception: " + ex);
            }

            Console.Out.WriteLine();
            Console.Out.WriteLine("checks run: " + _checks.ToString(CultureInfo.InvariantCulture));

            if (Failures.Count > 0)
            {
                Console.Out.WriteLine("FAILED: " + Failures.Count.ToString(CultureInfo.InvariantCulture));
                for (int i = 0; i < Failures.Count; i++)
                {
                    Console.Out.WriteLine("  - " + Failures[i]);
                }

                return 1;
            }

            Console.Out.WriteLine("PASSED");
            Console.Out.WriteLine("CACHE_PATH=" + cachePath);
            Console.Out.WriteLine("STREAM_PATH=" + streamPath);
            return 0;
        }

        // --------------------------------------------------- shared adapter core

        /// <summary>
        /// The version-adapter machinery that used to live inside the
        /// (uncompilable, unrunnable) Navisworks project and now lives in
        /// navisworks-common. It runs inside the Autodesk process for every
        /// supported year, so it is worth exercising here where it can actually
        /// be run.
        /// </summary>
        private static void CheckSupportedAdapterTable()
        {
            AdapterSupport[] adapters = SupportedAdapters.All();
            Check("at least one Navisworks year has an adapter", adapters.Length > 0);

            bool newestFirst = true;
            bool spellingHolds = true;
            bool lookupAgrees = true;
            HashSet<string> versions = new HashSet<string>(StringComparer.Ordinal);

            for (int i = 0; i < adapters.Length; i++)
            {
                if (i > 0 && adapters[i - 1].Year <= adapters[i].Year)
                {
                    newestFirst = false;
                }

                string expectedVersion = "navisworks-" + adapters[i].Year.ToString(CultureInfo.InvariantCulture);
                if (!string.Equals(adapters[i].AdapterVersion, expectedVersion, StringComparison.Ordinal))
                {
                    spellingHolds = false;
                }

                if (SupportedAdapters.ForYear(adapters[i].Year) == null ||
                    !SupportedAdapters.IsSupported(adapters[i].Year))
                {
                    lookupAgrees = false;
                }

                versions.Add(adapters[i].AdapterVersion);
            }

            // Selection walks this table in order and takes the first match, so
            // the ordering is behaviour, not presentation.
            Check("supported adapters are listed newest year first", newestFirst);
            Check("adapter_version reads navisworks-<year>", spellingHolds);
            Check("every listed year resolves through ForYear/IsSupported", lookupAgrees);
            Check("no two years share an adapter_version", versions.Count == adapters.Length);
            Check("a year with no adapter resolves to nothing", SupportedAdapters.ForYear(1999) == null);
            Check(
                "the supported year list names every adapter",
                SupportedAdapters.YearList().Split(',').Length == adapters.Length,
                SupportedAdapters.YearList());
        }

        /// <summary>
        /// The launcher relays the plugin's progress lines by sniffing a byte
        /// prefix and parsing only what matches, so a prefix that disagrees with
        /// what the writer emits fails silently: progress simply never appears.
        /// This is the check that makes the two halves meet.
        /// </summary>
        private static void CheckProgressLineSniffing()
        {
            StringWriter sink = new StringWriter(CultureInfo.InvariantCulture);
            using (NdjsonWriter writer = new NdjsonWriter(sink, false))
            {
                writer.WriteProgress(ExtractionStages.Sets, 7, 19);
            }

            string line = sink.ToString().TrimEnd('\n');
            byte[] prefix = NdjsonProgressLine.PrefixBytes();
            byte[] written = Encoding.UTF8.GetBytes(line);

            bool prefixMatches = written.Length >= prefix.Length;
            for (int i = 0; prefixMatches && i < prefix.Length; i++)
            {
                prefixMatches = written[i] == prefix[i];
            }

            Check("a written progress line starts with the sniffed prefix", prefixMatches, line);

            ProgressRecord parsed;
            bool parsedOk = NdjsonProgressLine.TryParse(line, out parsed);
            Check("a progress line parses back to its record", parsedOk, line);
            if (parsedOk)
            {
                Same("progress stage", ExtractionStages.Sets, parsed.Stage);
                Same("progress done", 7L, parsed.Done);
                Same("progress total", 19L, parsed.Total);
            }

            // Everything else on the stream must be rejected, or the launcher
            // would relay object records as progress.
            ProgressRecord rejected;
            Check(
                "an object line is not mistaken for progress",
                !NdjsonProgressLine.TryParse("{\"t\":\"object\",\"id\":1,\"stage\":\"walk\"}", out rejected));
            Check(
                "half a line is rejected rather than half-read",
                !NdjsonProgressLine.TryParse("{\"t\":\"prog\",\"stage\":\"se", out rejected));
        }

        /// <summary>
        /// The two rules in WarningCollector: the count matches the number of
        /// lines written, and a deferred warning does not reach the stream until
        /// it is flushed (which the walkers do straight after the object row it
        /// names).
        /// </summary>
        private static void CheckWarningCollector()
        {
            StringWriter sink = new StringWriter(CultureInfo.InvariantCulture);
            long countBeforeFlush;

            using (NdjsonWriter writer = new NdjsonWriter(sink, false))
            {
                WarningCollector warnings = new WarningCollector(writer);

                warnings.Defer(WarningSeverity.Info, WarningCodes.BoundingBoxReadFailed, "deferred", 42);
                warnings.Warn(WarningSeverity.Warning, WarningCodes.PropertyReadFailed, "immediate", null);
                countBeforeFlush = warnings.Count;

                warnings.FlushDeferred();
                Check("warning count matches lines emitted", warnings.Count == 2, warnings.Count.ToString());

                // A second flush must not re-emit anything.
                warnings.FlushDeferred();
                Check("flushing twice does not duplicate warnings", warnings.Count == 2);
            }

            Check("a deferred warning is not counted before it is written", countBeforeFlush == 1);

            string[] lines = sink.ToString().Split(new char[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
            Check("both warnings reached the stream", lines.Length == 2, lines.Length.ToString());
            Check(
                "the deferred warning is written after the immediate one",
                lines.Length == 2 && lines[0].Contains("immediate") && lines[1].Contains("deferred"));
        }

        /// <summary>
        /// ExtractionSession is what every version adapter's Execute() delegates
        /// to: exactly one terminator per run, a failure reported in-stream
        /// rather than through a return value, and no output path meaning no
        /// stream at all. ExtractionHeader rides along because the file-name-only
        /// rule is a confidentiality requirement, not a nicety.
        /// </summary>
        private static void CheckExtractionSession(string outputDirectory)
        {
            string inputPath = Path.Combine(outputDirectory, "SYNTHETIC-PLANT.nwd");
            string okPath = Path.Combine(outputDirectory, "session-ok.ndjson");
            string failPath = Path.Combine(outputDirectory, "session-failed.ndjson");
            Delete(okPath);
            Delete(failPath);

            int okExit = ExtractionSession.Run(okPath, new SyntheticWorkload(inputPath, false));
            Check("a completed session exits 0", okExit == ExtractionSession.ExitOk, okExit.ToString());

            List<StreamItem> okStream = ReadStream(okPath);
            Check("the completed session wrote a terminator", CountKind(okStream, ItemKind.End) == 1);

            EndRecord okEnd = LastEnd(okStream);
            Check("the terminator says ok", okEnd != null && okEnd.Ok);
            Check("the terminator carries the workload's counts",
                okEnd != null && okEnd.ObjectCount == 5 && okEnd.WarningCount == 2);

            Dictionary<string, string> meta = MetaOf(okStream);
            Check(
                "the header stamps adapter_version",
                meta.ContainsKey(CacheMetaKeys.AdapterVersion) &&
                meta[CacheMetaKeys.AdapterVersion] == "navisworks-2025");
            Check(
                "an unknown product version is spelled, not left blank",
                meta.ContainsKey(CacheMetaKeys.NavisworksVersion) &&
                meta[CacheMetaKeys.NavisworksVersion] == ExtractionHeader.UnknownProductVersion);
            Check(
                "the header records a file name, never a directory",
                meta.ContainsKey(CacheMetaKeys.InputFileName) &&
                meta[CacheMetaKeys.InputFileName] == "SYNTHETIC-PLANT.nwd",
                meta.ContainsKey(CacheMetaKeys.InputFileName) ? meta[CacheMetaKeys.InputFileName] : "absent");
            Check(
                "the header stamps the document's units",
                meta.ContainsKey(CacheMetaKeys.Units) && meta[CacheMetaKeys.Units] == "Meters");

            // Read from the running process rather than passed in, so this is the
            // only check that can catch it being written at all. Its VALUE is the
            // host's, so only its presence and shape are asserted.
            Check(
                "the header stamps the UI language it ran under",
                meta.ContainsKey(CacheMetaKeys.UiLanguage) &&
                meta[CacheMetaKeys.UiLanguage].Length > 0,
                meta.ContainsKey(CacheMetaKeys.UiLanguage) ? meta[CacheMetaKeys.UiLanguage] : "absent");

            int failExit = ExtractionSession.Run(failPath, new SyntheticWorkload(inputPath, true));
            Check("a failed session exits non-zero", failExit == ExtractionSession.ExitFailed, failExit.ToString());

            EndRecord failEnd = LastEnd(ReadStream(failPath));
            Check("a failure is reported in the stream, not just in the exit code", failEnd != null && !failEnd.Ok);
            Check(
                "an unrecognised failure falls back to EXTRACT_FAILED",
                failEnd != null && failEnd.Code == ExtractionErrorCodes.ExtractFailed,
                failEnd == null ? "no end record" : failEnd.Code);
            Check(
                "the failure names the exception type and message",
                failEnd != null && failEnd.Message == "InvalidOperationException: synthetic walk failure",
                failEnd == null ? "no end record" : failEnd.Message);

            int noPathExit = ExtractionSession.Run(null, new SyntheticWorkload(inputPath, false));
            Check(
                "no output path means no stream and a distinct exit code",
                noPathExit == ExtractionSession.ExitBadParameters,
                noPathExit.ToString());
        }

        /// <summary>
        /// Adapter selection: newest installed year that Matchline actually has
        /// an adapter for, Manage ahead of Simulate at the same year, and a
        /// newer Navisworks with no adapter skipped rather than used.
        /// <para>
        /// The installs are invented; only the choosing is under test. The real
        /// probe is exercised too, to the extent it can be off Windows: it must
        /// return an empty list rather than null or an exception.
        /// </para>
        /// </summary>
        private static void CheckAdapterSelection()
        {
            List<NavisworksInstall> probed = NavisworksLocator.FindAll();
            Check("probing for installs never returns null", probed != null);

            List<NavisworksInstall> installs = new List<NavisworksInstall>();
            installs.Add(Install("Manage", 2029));
            installs.Add(Install("Manage", 2026));
            installs.Add(Install("Simulate", 2026));
            installs.Add(Install("Manage", 2025));
            installs.Add(Install("Manage", 2023));

            NavisworksInstall newest = NavisworksLocator.SelectNewestSupported(installs);
            Check("selection skips a release with no adapter", newest != null && newest.Year == 2026,
                newest == null ? "nothing selected" : newest.Describe());
            Check("Manage wins over Simulate at the same year",
                newest != null && newest.Product == "Manage");

            NavisworksInstall requested = NavisworksLocator.SelectYear(installs, 2025);
            Check("an explicit year selects that install", requested != null && requested.Year == 2025);
            Check("an explicit year that is not installed selects nothing",
                NavisworksLocator.SelectYear(installs, 2024) == null);

            List<NavisworksInstall> unsupportedOnly = new List<NavisworksInstall>();
            unsupportedOnly.Add(Install("Manage", 2023));
            Check("an install with no adapter is not selectable",
                NavisworksLocator.SelectNewestSupported(unsupportedOnly) == null);
            Check("nothing installed selects nothing",
                NavisworksLocator.SelectNewestSupported(new List<NavisworksInstall>()) == null);

            // The "installed, but no adapter for it" error is only actionable if
            // it says what was found.
            string described = NavisworksLocator.DescribeAll(unsupportedOnly);
            Check("the error text names what was found", described.Contains("2023") && described.Contains("Manage"),
                described);
            Check("nothing found describes as empty",
                NavisworksLocator.DescribeAll(new List<NavisworksInstall>()).Length == 0);

            Check("an unknown year describes without pretending to know one",
                Install("Unknown", NavisworksLocator.UnknownYear).Describe().Contains("unknown year"));
        }

        private static NavisworksInstall Install(string product, int year)
        {
            string directory = Path.Combine(
                "C:", "Program Files", "Autodesk",
                "Navisworks " + product + " " + year.ToString(CultureInfo.InvariantCulture));

            return new NavisworksInstall(
                directory, Path.Combine(directory, NavisworksLocator.ExecutableName), product, year);
        }

        /// <summary>
        /// --navisworks-version. Asking for a year Matchline has no adapter for
        /// is a wrong command line, not a runtime surprise, so it is refused at
        /// parse time and the message says which years exist.
        /// </summary>
        private static void CheckVersionArgument()
        {
            ExtractorArguments parsed;
            string error;

            Check("a supported year parses",
                ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--navisworks-version", "2025" },
                    out parsed, out error) && parsed.NavisworksYear == 2025,
                error);

            Check("no flag means newest installed",
                ExtractorArguments.TryParse(new string[] { "--input", "model.nwd" }, out parsed, out error) &&
                !parsed.NavisworksYear.HasValue,
                error);

            bool refusedUnsupported = !ExtractorArguments.TryParse(
                new string[] { "--input", "model.nwd", "--navisworks-version", "2023" },
                out parsed, out error);
            Check("a year with no adapter is refused", refusedUnsupported);
            Check("and the refusal lists the years that do have one",
                error != null && error.Contains(SupportedAdapters.YearList()),
                error);

            Check("a non-numeric version is refused",
                !ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--navisworks-version", "twenty-five" },
                    out parsed, out error));

            Check("a version flag with no value is refused",
                !ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--navisworks-version" },
                    out parsed, out error));

            Check("pinning both a folder and a year is refused rather than silently resolved",
                !ExtractorArguments.TryParse(
                    new string[]
                    {
                        "--input", "model.nwd",
                        "--navisworks-dir", "C:\\Navisworks",
                        "--navisworks-version", "2025"
                    },
                    out parsed, out error));
        }

        /// <summary>
        /// --input-sha256, both ways.
        /// <para>
        /// The flag exists so a caller that already streamed the input's hash
        /// does not make the launcher read a multi-gigabyte model a second time
        /// to compute the same number (docs/RELEASE-1.0-PLAN.md, "Performance /
        /// isolation"). The value is TRUSTED at run time -- verifying it would
        /// be the read it exists to avoid -- so the whole of the checking is
        /// here, at parse time, and it has to be strict: this value becomes a
        /// file name and a cache nobody can find again is worse than a refused
        /// command line.
        /// </para>
        /// <para>
        /// The run-time half of the flag lives in ExtractionRunner, which is
        /// net48 and cannot be executed here. What can be checked here is what
        /// the parser accepts, what it refuses, and the one normalisation it
        /// performs; the TypeScript side exercises the skip itself against a
        /// second implementation of the same protocol
        /// (apps/desktop/test/extraction-service.test.mjs).
        /// </para>
        /// </summary>
        private static void CheckInputShaArgument()
        {
            ExtractorArguments parsed;
            string error;

            string lower = new string('a', 64);
            Check(
                "a 64-digit hash parses",
                ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--input-sha256", lower },
                    out parsed, out error) && parsed.InputSha256 == lower,
                error);

            Check(
                "no flag means the launcher hashes the input itself",
                ExtractorArguments.TryParse(new string[] { "--input", "model.nwd" }, out parsed, out error) &&
                parsed.InputSha256 == null,
                error);

            Check(
                "an upper-case hash is folded rather than refused",
                ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--input-sha256", new string('C', 64) },
                    out parsed, out error) && parsed.InputSha256 == new string('c', 64),
                error);

            // Every one of these would otherwise become a cache file name.
            string[] malformed = new string[]
            {
                string.Empty,
                "abc",
                new string('z', 64),
                new string('a', 63),
                new string('a', 65),
                "0x" + new string('a', 62),
                new string('a', 63) + " ",
            };

            bool allRefused = true;
            string accepted = null;
            for (int i = 0; i < malformed.Length; i++)
            {
                if (ExtractorArguments.TryParse(
                        new string[] { "--input", "model.nwd", "--input-sha256", malformed[i] },
                        out parsed, out error))
                {
                    allRefused = false;
                    accepted = "'" + malformed[i] + "'";
                    break;
                }
            }

            Check("a malformed hash is refused, never reinterpreted", allRefused, accepted);

            Check(
                "and the refusal says what the flag takes",
                !ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--input-sha256", "abc" },
                    out parsed, out error) && error != null && error.Contains("64 hex digits"),
                error);

            Check(
                "a hash flag with no value is refused",
                !ExtractorArguments.TryParse(
                    new string[] { "--input", "model.nwd", "--input-sha256" },
                    out parsed, out error));

            // The normaliser is what the parser leans on, checked directly so a
            // failure names the rule rather than the command line around it.
            string normalised;
            Check(
                "the normaliser folds case and nothing else",
                ExtractorArguments.TryNormaliseSha256("AbCdEf" + new string('0', 58), out normalised) &&
                normalised == "abcdef" + new string('0', 58));
            Check(
                "the normaliser refuses null",
                !ExtractorArguments.TryNormaliseSha256(null, out normalised) && normalised == null);
        }

        /// <summary>Stands in for a version adapter's walk: header, then records or a failure.</summary>
        private sealed class SyntheticWorkload : IExtractionWorkload
        {
            private readonly string _inputPath;
            private readonly bool _fail;

            internal SyntheticWorkload(string inputPath, bool fail)
            {
                _inputPath = inputPath;
                _fail = fail;
            }

            public ExtractionCounts Run(NdjsonWriter writer)
            {
                ExtractionHeader.Write(writer, "navisworks-2025", null, _inputPath, null, "Meters");

                if (_fail)
                {
                    throw new InvalidOperationException("synthetic walk failure");
                }

                return new ExtractionCounts(5, 2);
            }
        }

        private static EndRecord LastEnd(List<StreamItem> items)
        {
            for (int i = items.Count - 1; i >= 0; i--)
            {
                if (items[i].Kind == ItemKind.End)
                {
                    return items[i].End;
                }
            }

            return null;
        }

        private static Dictionary<string, string> MetaOf(List<StreamItem> items)
        {
            Dictionary<string, string> meta = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 0; i < items.Count; i++)
            {
                if (items[i].Kind == ItemKind.Meta)
                {
                    meta[items[i].Meta.Key] = items[i].Meta.Value;
                }
            }

            return meta;
        }

        // ---------------------------------------------------------------- data

        private enum ItemKind
        {
            Meta,
            Model,
            Reference,
            Object,
            Property,
            SelectionSet,
            SelectionSetMember,
            Warning,
            Progress,
            End,
        }

        private sealed class StreamItem
        {
            internal ItemKind Kind { get; set; }

            internal MetaRecord Meta { get; set; }

            internal SourceModelRecord Model { get; set; }

            internal SourceReferenceRecord Reference { get; set; }

            internal ObjectRecord Object { get; set; }

            internal PropertyRecord Property { get; set; }

            internal SelectionSetRecord Set { get; set; }

            internal SelectionSetMemberRecord Member { get; set; }

            internal WarningRecord Warning { get; set; }

            internal ProgressRecord Progress { get; set; }

            internal EndRecord End { get; set; }
        }

        /// <summary>
        /// A small invented plant, shaped exactly the way DocumentWalker emits:
        /// meta first, then each source model followed by its items depth-first
        /// pre-order, each item's properties right after it, then selection sets,
        /// then the terminator. Warnings appear only after the object they name,
        /// which is the ordering DocumentWalker.EmitObject now guarantees.
        /// </summary>
        private static List<StreamItem> BuildSyntheticStream()
        {
            List<StreamItem> items = new List<StreamItem>();

            items.Add(MetaItem(CacheMetaKeys.AdapterVersion, "navisworks-2025"));
            items.Add(MetaItem(CacheMetaKeys.NavisworksVersion, "2025"));
            items.Add(MetaItem(CacheMetaKeys.Units, "Meters"));
            items.Add(MetaItem(CacheMetaKeys.UiLanguage, "en-US"));
            items.Add(MetaItem(CacheMetaKeys.InputFileName, "SYNTHETIC-PLANT.nwd"));

            // What the document references, before anything else. One of the two
            // did not load, which is the shape ExtractionRunner refuses to commit
            // -- so this stream is deliberately NOT a stream that would produce a
            // cache in production. What is being exercised here is the record
            // round-tripping and the cache tables, both of which are the same
            // either way.
            items.Add(ReferenceItem("SYNTHETIC-PLANT-A.nwc", true));
            items.Add(ReferenceItem("SYNTHETIC-PLANT-MISSING.nwc", false));

            // Saved sets FIRST, then the walk, then each item's memberships
            // inline -- the order DocumentWalker emits since the set/walk
            // inversion. The stage announces itself with a total before it
            // resolves anything.
            items.Add(ProgressItem(ExtractionStages.Sets, 0, 3));

            items.Add(SetItem(1, null, "Mechanical", SelectionSetKind.Folder, true));
            items.Add(SetItem(2, 1, "Pumps", SelectionSetKind.Selection, true));
            items.Add(ProgressItem(ExtractionStages.Sets, 1, 3));

            // A saved search that DID resolve. Schema v1 could not represent
            // this at all -- it recorded searches without members, so members
            // present meant explicit and members absent meant unknown.
            items.Add(SetItem(3, 1, "All Valves", SelectionSetKind.Search, true));
            items.Add(ProgressItem(ExtractionStages.Sets, 2, 3));

            // And one that did not: no member rows at all, and a warning naming
            // it. This is the row that proves absent is distinguishable from
            // empty (schemas/extraction-cache.sql, membership_resolved).
            // A set with no GUID as well, because SavedItem.Guid may not answer.
            items.Add(SetItem(4, null, "Unresolvable Search", SelectionSetKind.Search, false, null));
            items.Add(WarningItem(
                WarningSeverity.Warning, WarningCodes.SearchSetUnresolved,
                "Search set 'Unresolvable Search' could not be resolved and is recorded without members: " +
                "synthetic search failure.", null));
            items.Add(ProgressItem(ExtractionStages.Sets, 3, 3));

            items.Add(ModelItem(
                1, null, "SYNTHETIC-PLANT-A.nwc", "Plant A", "11111111-2222-3333-4444-555555555555",
                "SYNTHETIC-PLANT-A.rvt", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
            items.Add(ModelItem(2, null, "SYNTHETIC-PLANT-B.nwc", null, null, null, null));

            // Model 1, depth-first: 1 > (2 > (3, 4), 5 > 6)
            items.Add(ObjectItem(
                1, 1, null, 0, 0, "Plant A", "Group", Box(0, 0, 0, 100, 60, 24),
                null, null, ObjectFlags.HasModel | ObjectFlags.Collection));
            items.Add(ObjectItem(
                2, 1, 1, 0, 1, "Level 1", "Group", null, null, null, ObjectFlags.Layer));
            items.Add(ObjectItem(
                3, 1, 2, 0, 2, "Pump P-101", "Insert Group", Box(1.5, 2.25, 0, 3.5, 4.25, 2),
                "418022", AuthoringIdKinds.RevitElementId, ObjectFlags.Insert | ObjectFlags.Composite));
            AddPropertiesForPump(items);
            items.Add(WarningItem(WarningSeverity.Info, WarningCodes.BoundingBoxReadFailed, "synthetic bbox note", 3));

            // Membership rows follow their object, not their set: the set row
            // already exists, so both ends of the row are on the stream.
            items.Add(MemberItem(2, 3));
            // Deliberate duplicate: a saved set can list the same item twice and
            // the cache's INSERT OR IGNORE must collapse it to one row.
            items.Add(MemberItem(2, 3));

            // A hidden item, which the walk visits and records rather than skips.
            items.Add(ObjectItem(
                4, 1, 2, 1, 2, "Valve V-101", "Insert Group", null,
                "3n0Xk9Qb1EOhE$Wr0000AB", AuthoringIdKinds.IfcGlobalId,
                ObjectFlags.Hidden | ObjectFlags.Insert));
            items.Add(WarningItem(
                WarningSeverity.Warning, WarningCodes.PropertyReadFailed, "synthetic property failure", 4));
            items.Add(MemberItem(3, 4));

            items.Add(ObjectItem(5, 1, 1, 1, 1, "Level 2", "Group", null, null, null, ObjectFlags.Layer));

            // Object 6's box contains a NaN. The writer spells NaN as JSON null,
            // the reader turns any NaN back into "no box at all": all-or-none per
            // row, exactly as schemas/extraction-cache.sql requires.
            items.Add(ObjectItem(
                6, 1, 5, 0, 2, "Tank T-201", "Insert Group",
                new double[] { 10, 10, 0, double.NaN, 14, 8 },
                "2A7F", AuthoringIdKinds.DwgHandle, ObjectFlags.None));
            items.Add(MemberItem(2, 6));

            // Model 2. Root path_index 1, matching the order Document.Models
            // yields its top-level models.
            items.Add(ObjectItem(7, 2, null, 1, 0, "Plant B", "Group", null, null, null, ObjectFlags.HasModel));

            // A nested appended model, discovered mid-walk: its row is written
            // when the walk reaches the item that carries it, so its id is higher
            // than every top-level model's and its parent_id names the model it
            // was appended into.
            items.Add(ModelItem(
                3, 2, "SYNTHETIC-DUCT.nwc", "Ductwork", "33333333-4444-5555-6666-777777777777",
                "SYNTHETIC-DUCT.dwg", "cccccccc-dddd-eeee-ffff-000000000000"));
            items.Add(ObjectItem(
                8, 3, 7, 0, 1, "Duct D-001", "Insert Group", Box(-5, -5, -1, 5, 5, 1),
                null, null, ObjectFlags.HasModel | ObjectFlags.Composite));

            items.Add(WarningItem(
                WarningSeverity.Error, WarningCodes.SourceModelMissing,
                "The document references 'SYNTHETIC-PLANT-MISSING.nwc' but that file is not where " +
                "the document expects it and nothing was loaded from it. Everything it holds is " +
                "absent from this extraction.", null));

            items.Add(WarningItem(
                WarningSeverity.Error, WarningCodes.SourceModelReadFailed, "synthetic model-level failure", null));

            EndRecord end = new EndRecord();
            end.Ok = true;
            end.Code = null;
            end.Message = null;
            end.ObjectCount = 8;
            end.WarningCount = 5;
            items.Add(new StreamItem { Kind = ItemKind.End, End = end });

            return items;
        }

        /// <summary>
        /// Values chosen to break a naive JSON writer: embedded quotes,
        /// backslashes, tabs and newlines, a control character, non-ASCII, an
        /// empty string, an explicit null, and a double at the edge of range.
        /// </summary>
        private static void AddPropertiesForPump(List<StreamItem> items)
        {
            items.Add(PropertyItem(3, "Item", "LcOaNode", "Name", "LcOaSceneBaseUserName",
                "Pump \"P-101\"", "DisplayString"));
            items.Add(PropertyItem(3, "Element", "LcRevitData", "Path\\Segment", null,
                "C:\\plant\\area\\pump.rvt", "DisplayString"));
            items.Add(PropertyItem(3, "Element", "LcRevitData", "Tab\tSeparated", null,
                "first line\nsecond line\rthird\u0007", "DisplayString"));
            items.Add(PropertyItem(3, "Dimensions", null, "Diameter", null,
                "\u00d8 150 mm \u2014 \u00c5ngstr\u00f6m \u00a7", "DisplayString"));
            items.Add(PropertyItem(3, "Dimensions", null, "Volume", null,
                (1.7976931348623157E+308).ToString("R", CultureInfo.InvariantCulture), "DoubleVolume"));
            items.Add(PropertyItem(3, "Dimensions", null, "Tolerance", null,
                (-0.000000000000000012345).ToString("R", CultureInfo.InvariantCulture), "Double"));
            items.Add(PropertyItem(3, "Item", "LcOaNode", "Hidden", null, null, "None"));
            items.Add(PropertyItem(3, "Item", "LcOaNode", "Blank", null, string.Empty, "IdentifierString"));
        }

        private static double[] Box(double a, double b, double c, double d, double e, double f)
        {
            return new double[] { a, b, c, d, e, f };
        }

        private static StreamItem MetaItem(string key, string value)
        {
            MetaRecord record = new MetaRecord();
            record.Key = key;
            record.Value = value;
            return new StreamItem { Kind = ItemKind.Meta, Meta = record };
        }

        private static StreamItem ModelItem(
            long id, long? parentId, string fileName, string displayName, string guid,
            string sourceFileName, string sourceGuid)
        {
            SourceModelRecord record = new SourceModelRecord();
            record.Id = id;
            record.ParentId = parentId;
            record.FileName = fileName;
            record.DisplayName = displayName;
            record.Guid = guid;
            record.SourceFileName = sourceFileName;
            record.SourceGuid = sourceGuid;
            return new StreamItem { Kind = ItemKind.Model, Model = record };
        }

        private static StreamItem ReferenceItem(string sourceFileName, bool loaded)
        {
            SourceReferenceRecord record = new SourceReferenceRecord();
            record.SourceFileName = sourceFileName;
            record.Loaded = loaded;
            return new StreamItem { Kind = ItemKind.Reference, Reference = record };
        }

        private static StreamItem ObjectItem(
            long id, long? modelId, long? parentId, int pathIndex, int depth,
            string displayName, string className, double[] box,
            string authoringId, string authoringIdKind, long flags)
        {
            ObjectRecord record = new ObjectRecord();
            record.Id = id;
            record.SourceModelId = modelId;
            record.ParentId = parentId;
            record.PathIndex = pathIndex;
            record.Depth = depth;
            record.DisplayName = displayName;
            record.ClassName = className;
            record.InstanceGuid = new Guid(
                (int)id, 0x1234, 0x5678, 1, 2, 3, 4, 5, 6, 7, 8).ToString("D", CultureInfo.InvariantCulture);
            record.AuthoringId = authoringId;
            record.AuthoringIdKind = authoringIdKind;

            // A stand-in for the walker's SHA-256, and the shape is what matters
            // here: 64 lowercase hex characters, one per object, stable per id.
            record.StructuralKey = SyntheticStructuralKey(id);
            record.Flags = flags;
            record.BoundingBox = box;
            return new StreamItem { Kind = ItemKind.Object, Object = record };
        }

        /// <summary>
        /// 64 hex characters derived from the object id. Not the walker's
        /// algorithm -- that needs a ModelItem tree -- but the same shape, so the
        /// column, the wire field and the reader are all exercised against a
        /// realistic value.
        /// </summary>
        private static string SyntheticStructuralKey(long id)
        {
            string seed = id.ToString("x", CultureInfo.InvariantCulture);
            return seed.PadLeft(64, 'a');
        }

        private static StreamItem PropertyItem(
            long objectId, string category, string categoryInternal,
            string name, string nameInternal, string valueText, string valueType)
        {
            PropertyRecord record = new PropertyRecord();
            record.ObjectId = objectId;
            record.Category = category;
            record.CategoryInternal = categoryInternal;
            record.Name = name;
            record.NameInternal = nameInternal;
            record.ValueText = valueText;
            record.ValueType = valueType;
            return new StreamItem { Kind = ItemKind.Property, Property = record };
        }

        private static StreamItem SetItem(
            long id, long? parentId, string name, string kind, bool membershipResolved)
        {
            return SetItem(id, parentId, name, kind, membershipResolved,
                new Guid((int)(0x5E700000 + id), 0x4321, 0x8765, 9, 8, 7, 6, 5, 4, 3, 2)
                    .ToString("D", CultureInfo.InvariantCulture));
        }

        private static StreamItem SetItem(
            long id, long? parentId, string name, string kind, bool membershipResolved, string guid)
        {
            SelectionSetRecord record = new SelectionSetRecord();
            record.Id = id;
            record.ParentId = parentId;
            record.Name = name;
            record.Kind = kind;
            record.MembershipResolved = membershipResolved;
            record.Guid = guid;
            return new StreamItem { Kind = ItemKind.SelectionSet, Set = record };
        }

        private static StreamItem ProgressItem(string stage, long done, long total)
        {
            ProgressRecord record = new ProgressRecord();
            record.Stage = stage;
            record.Done = done;
            record.Total = total;
            return new StreamItem { Kind = ItemKind.Progress, Progress = record };
        }

        private static StreamItem MemberItem(long setId, long objectId)
        {
            SelectionSetMemberRecord record = new SelectionSetMemberRecord();
            record.SetId = setId;
            record.ObjectId = objectId;
            return new StreamItem { Kind = ItemKind.SelectionSetMember, Member = record };
        }

        private static StreamItem WarningItem(string severity, string code, string message, long? objectId)
        {
            WarningRecord record = new WarningRecord();
            record.Severity = severity;
            record.Code = code;
            record.Message = message;
            record.ObjectId = objectId;
            return new StreamItem { Kind = ItemKind.Warning, Warning = record };
        }

        // ------------------------------------------------------------- stream

        private static void WriteStream(string path, List<StreamItem> items)
        {
            using (NdjsonWriter writer = NdjsonWriter.CreateFile(path))
            {
                for (int i = 0; i < items.Count; i++)
                {
                    StreamItem item = items[i];
                    switch (item.Kind)
                    {
                        case ItemKind.Meta:
                            writer.WriteMeta(item.Meta);
                            break;
                        case ItemKind.Model:
                            writer.WriteSourceModel(item.Model);
                            break;
                        case ItemKind.Reference:
                            writer.WriteSourceReference(item.Reference);
                            break;
                        case ItemKind.Object:
                            writer.WriteObject(item.Object);
                            break;
                        case ItemKind.Property:
                            writer.WriteProperty(item.Property);
                            break;
                        case ItemKind.SelectionSet:
                            writer.WriteSelectionSet(item.Set);
                            break;
                        case ItemKind.SelectionSetMember:
                            writer.WriteSelectionSetMember(item.Member);
                            break;
                        case ItemKind.Warning:
                            writer.WriteWarning(item.Warning);
                            break;
                        case ItemKind.Progress:
                            writer.WriteProgress(item.Progress);
                            break;
                        case ItemKind.End:
                            writer.WriteEnd(item.End);
                            break;
                        default:
                            throw new InvalidOperationException("unhandled kind " + item.Kind);
                    }
                }
            }

            byte[] bytes = File.ReadAllBytes(path);
            Check("stream has no BOM", bytes.Length < 3 || bytes[0] != 0xEF || bytes[1] != 0xBB || bytes[2] != 0xBF);
            Check("stream has no CR", Array.IndexOf(bytes, (byte)'\r') < 0);
            Check(
                "stream line count matches record count",
                CountBytes(bytes, (byte)'\n') == items.Count,
                CountBytes(bytes, (byte)'\n') + " newlines for " + items.Count + " records");
        }

        private static List<StreamItem> ReadStream(string path)
        {
            List<StreamItem> items = new List<StreamItem>();
            using (NdjsonReader reader = NdjsonReader.OpenFile(path))
            {
                while (true)
                {
                    NdjsonEntry entry = reader.ReadNext();
                    if (entry == null)
                    {
                        break;
                    }

                    StreamItem item = new StreamItem();
                    if (entry.Meta != null)
                    {
                        item.Kind = ItemKind.Meta;
                        item.Meta = entry.Meta;
                    }
                    else if (entry.SourceModel != null)
                    {
                        item.Kind = ItemKind.Model;
                        item.Model = entry.SourceModel;
                    }
                    else if (entry.SourceReference != null)
                    {
                        item.Kind = ItemKind.Reference;
                        item.Reference = entry.SourceReference;
                    }
                    else if (entry.Object != null)
                    {
                        item.Kind = ItemKind.Object;
                        item.Object = entry.Object;
                    }
                    else if (entry.Property != null)
                    {
                        item.Kind = ItemKind.Property;
                        item.Property = entry.Property;
                    }
                    else if (entry.SelectionSet != null)
                    {
                        item.Kind = ItemKind.SelectionSet;
                        item.Set = entry.SelectionSet;
                    }
                    else if (entry.SelectionSetMember != null)
                    {
                        item.Kind = ItemKind.SelectionSetMember;
                        item.Member = entry.SelectionSetMember;
                    }
                    else if (entry.Warning != null)
                    {
                        item.Kind = ItemKind.Warning;
                        item.Warning = entry.Warning;
                    }
                    else if (entry.Progress != null)
                    {
                        item.Kind = ItemKind.Progress;
                        item.Progress = entry.Progress;
                    }
                    else if (entry.End != null)
                    {
                        item.Kind = ItemKind.End;
                        item.End = entry.End;
                    }
                    else
                    {
                        Failures.Add("line " + entry.LineNumber + " parsed to no known record (t=" + entry.Type + ")");
                        continue;
                    }

                    items.Add(item);
                }
            }

            return items;
        }

        private static void CompareStreams(List<StreamItem> expected, List<StreamItem> actual)
        {
            Check(
                "round trip preserves record count",
                expected.Count == actual.Count,
                expected.Count + " written, " + actual.Count + " read back");

            int count = Math.Min(expected.Count, actual.Count);
            for (int i = 0; i < count; i++)
            {
                StreamItem e = expected[i];
                StreamItem a = actual[i];
                string at = "record " + i.ToString(CultureInfo.InvariantCulture);

                if (!Check(at + " kind", e.Kind == a.Kind, e.Kind + " != " + a.Kind))
                {
                    continue;
                }

                switch (e.Kind)
                {
                    case ItemKind.Meta:
                        Same(at + " meta.key", e.Meta.Key, a.Meta.Key);
                        Same(at + " meta.value", e.Meta.Value, a.Meta.Value);
                        break;

                    case ItemKind.Model:
                        Same(at + " model.id", e.Model.Id, a.Model.Id);
                        Same(at + " model.parent", e.Model.ParentId, a.Model.ParentId);
                        Same(at + " model.file", e.Model.FileName, a.Model.FileName);
                        Same(at + " model.name", e.Model.DisplayName, a.Model.DisplayName);
                        Same(at + " model.guid", e.Model.Guid, a.Model.Guid);
                        Same(at + " model.sfile", e.Model.SourceFileName, a.Model.SourceFileName);
                        Same(at + " model.sguid", e.Model.SourceGuid, a.Model.SourceGuid);
                        break;

                    case ItemKind.Reference:
                        Same(at + " ref.sfile", e.Reference.SourceFileName, a.Reference.SourceFileName);
                        Same(at + " ref.loaded", e.Reference.Loaded, a.Reference.Loaded);
                        break;

                    case ItemKind.Object:
                        Same(at + " object.id", e.Object.Id, a.Object.Id);
                        Same(at + " object.model", e.Object.SourceModelId, a.Object.SourceModelId);
                        Same(at + " object.parent", e.Object.ParentId, a.Object.ParentId);
                        Same(at + " object.idx", e.Object.PathIndex, a.Object.PathIndex);
                        Same(at + " object.depth", e.Object.Depth, a.Object.Depth);
                        Same(at + " object.name", e.Object.DisplayName, a.Object.DisplayName);
                        Same(at + " object.class", e.Object.ClassName, a.Object.ClassName);
                        Same(at + " object.iguid", e.Object.InstanceGuid, a.Object.InstanceGuid);
                        Same(at + " object.aid", e.Object.AuthoringId, a.Object.AuthoringId);
                        Same(at + " object.aidk", e.Object.AuthoringIdKind, a.Object.AuthoringIdKind);
                        Same(at + " object.skey", e.Object.StructuralKey, a.Object.StructuralKey);
                        Same(at + " object.flags", e.Object.Flags, a.Object.Flags);
                        SameBox(at + " object.bbox", e.Object.BoundingBox, a.Object.BoundingBox);
                        break;

                    case ItemKind.Property:
                        Same(at + " prop.obj", e.Property.ObjectId, a.Property.ObjectId);
                        Same(at + " prop.cat", e.Property.Category, a.Property.Category);
                        Same(at + " prop.cati", e.Property.CategoryInternal, a.Property.CategoryInternal);
                        Same(at + " prop.name", e.Property.Name, a.Property.Name);
                        Same(at + " prop.namei", e.Property.NameInternal, a.Property.NameInternal);
                        Same(at + " prop.val", e.Property.ValueText, a.Property.ValueText);
                        Same(at + " prop.vt", e.Property.ValueType, a.Property.ValueType);
                        break;

                    case ItemKind.SelectionSet:
                        Same(at + " set.id", e.Set.Id, a.Set.Id);
                        Same(at + " set.parent", e.Set.ParentId, a.Set.ParentId);
                        Same(at + " set.name", e.Set.Name, a.Set.Name);
                        Same(at + " set.kind", e.Set.Kind, a.Set.Kind);
                        Same(at + " set.res", e.Set.MembershipResolved, a.Set.MembershipResolved);
                        Same(at + " set.guid", e.Set.Guid, a.Set.Guid);
                        break;

                    case ItemKind.SelectionSetMember:
                        Same(at + " member.set", e.Member.SetId, a.Member.SetId);
                        Same(at + " member.obj", e.Member.ObjectId, a.Member.ObjectId);
                        break;

                    case ItemKind.Warning:
                        Same(at + " warn.sev", e.Warning.Severity, a.Warning.Severity);
                        Same(at + " warn.code", e.Warning.Code, a.Warning.Code);
                        Same(at + " warn.msg", e.Warning.Message, a.Warning.Message);
                        Same(at + " warn.obj", e.Warning.ObjectId, a.Warning.ObjectId);
                        break;

                    case ItemKind.Progress:
                        Same(at + " prog.stage", e.Progress.Stage, a.Progress.Stage);
                        Same(at + " prog.done", e.Progress.Done, a.Progress.Done);
                        Same(at + " prog.total", e.Progress.Total, a.Progress.Total);
                        break;

                    case ItemKind.End:
                        Same(at + " end.ok", e.End.Ok, a.End.Ok);
                        Same(at + " end.code", e.End.Code, a.End.Code);
                        Same(at + " end.msg", e.End.Message, a.End.Message);
                        Same(at + " end.objects", e.End.ObjectCount, a.End.ObjectCount);
                        Same(at + " end.warnings", e.End.WarningCount, a.End.WarningCount);
                        break;

                    default:
                        Failures.Add(at + ": unhandled kind " + e.Kind);
                        break;
                }
            }
        }

        /// <summary>
        /// The invariant DocumentWalker.EmitObject exists to hold: a warning that
        /// names an object id must never appear before that object's record. Get
        /// this wrong and the stream cannot be replayed into a cache with
        /// foreign-key enforcement on.
        /// </summary>
        private static void CheckWarningsFollowTheirObject(List<StreamItem> items)
        {
            HashSet<long> seen = new HashSet<long>();
            bool ordered = true;
            string detail = null;

            for (int i = 0; i < items.Count; i++)
            {
                if (items[i].Kind == ItemKind.Object)
                {
                    seen.Add(items[i].Object.Id);
                    continue;
                }

                if (items[i].Kind == ItemKind.Warning && items[i].Warning.ObjectId.HasValue &&
                    !seen.Contains(items[i].Warning.ObjectId.Value))
                {
                    ordered = false;
                    detail = "warning at record " + i + " names object " + items[i].Warning.ObjectId.Value +
                        ", which has not been emitted yet";
                    break;
                }
            }

            Check("every warning follows the object it names", ordered, detail);
        }

        // -------------------------------------------------------------- cache

        private static void BuildCache(
            List<StreamItem> items, string partialPath, string cachePath, long objectCount)
        {
            Dictionary<string, string> meta = new Dictionary<string, string>(StringComparer.Ordinal);

            using (CacheWriter writer = CacheWriter.Create(partialPath))
            {
                for (int i = 0; i < items.Count; i++)
                {
                    StreamItem item = items[i];
                    switch (item.Kind)
                    {
                        case ItemKind.Meta:
                            meta[item.Meta.Key] = item.Meta.Value ?? string.Empty;
                            break;
                        case ItemKind.Model:
                            writer.WriteSourceModel(item.Model);
                            break;
                        case ItemKind.Reference:
                            // What the document REFERENCES is not what it holds;
                            // a reference that did not load reaches the cache as
                            // an error-severity warning and nothing else.
                            break;
                        case ItemKind.Object:
                            writer.WriteObject(item.Object);
                            break;
                        case ItemKind.Property:
                            writer.WriteProperty(item.Property);
                            break;
                        case ItemKind.SelectionSet:
                            writer.WriteSelectionSet(item.Set);
                            break;
                        case ItemKind.SelectionSetMember:
                            writer.WriteSelectionSetMember(item.Member);
                            break;
                        case ItemKind.Warning:
                            writer.WriteWarning(item.Warning);
                            break;
                        case ItemKind.Progress:
                            // Relayed live by the launcher's stream monitor; it
                            // is not a row in any table.
                            break;
                        case ItemKind.End:
                            break;
                        default:
                            throw new InvalidOperationException("unhandled kind " + item.Kind);
                    }
                }

                // The launcher's half of meta, same keys ExtractionRunner supplies.
                meta[CacheMetaKeys.SchemaVersion] = CacheMetaKeys.CurrentSchemaVersion;
                meta[CacheMetaKeys.InputFileName] = "SYNTHETIC-PLANT.nwd";
                meta[CacheMetaKeys.InputSha256] =
                    "0000000000000000000000000000000000000000000000000000000000000000";
                meta[CacheMetaKeys.InputBytes] = "4096";
                meta[CacheMetaKeys.ExtractedAtUtc] =
                    DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
                meta[CacheMetaKeys.ExtractorVersion] = "0.1.0";

                writer.Commit(partialPath, cachePath, meta, objectCount);
            }

            Check("commit produced the final cache", File.Exists(cachePath));
            Check("commit left no .partial behind", !File.Exists(partialPath));
        }

        private static void CheckCacheContents(string cachePath, List<StreamItem> expected)
        {
            using (SqliteConnection connection = OpenReadOnly(cachePath))
            {
                Check(
                    "objects row count",
                    Scalar(connection, "SELECT COUNT(*) FROM objects") == CountKind(expected, ItemKind.Object));
                Check(
                    "source_models row count",
                    Scalar(connection, "SELECT COUNT(*) FROM source_models") == CountKind(expected, ItemKind.Model));
                Check(
                    "properties row count",
                    Scalar(connection, "SELECT COUNT(*) FROM properties") == CountKind(expected, ItemKind.Property));
                Check(
                    "selection_sets row count",
                    Scalar(connection, "SELECT COUNT(*) FROM selection_sets")
                        == CountKind(expected, ItemKind.SelectionSet));
                Check(
                    "warnings row count",
                    Scalar(connection, "SELECT COUNT(*) FROM warnings") == CountKind(expected, ItemKind.Warning));

                // Four member lines, one of them a duplicate: INSERT OR IGNORE.
                Check(
                    "duplicate selection-set member collapsed",
                    Scalar(connection, "SELECT COUNT(*) FROM selection_set_members") == 3,
                    "expected 3 distinct members from 4 lines");

                Check(
                    "meta.object_count agrees with the objects table",
                    Scalar(connection, "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'object_count'")
                        == Scalar(connection, "SELECT COUNT(*) FROM objects"));

                Check(
                    "every required meta key is present and non-empty",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM meta WHERE value <> '' AND key IN " +
                        "('schema_version','input_file_name','input_sha256','input_bytes','extracted_at_utc'," +
                        "'extractor_version','adapter_version','navisworks_version','object_count')") == 9);

                // v3's two optional keys. They are written by the adapter, not by
                // the launcher, and the required set deliberately does not name
                // them -- every cache an older adapter wrote lacks both.
                Check(
                    "meta.units and meta.ui_language survive the round trip",
                    Text(connection, "SELECT value FROM meta WHERE key = 'units'") == "Meters" &&
                    Text(connection, "SELECT value FROM meta WHERE key = 'ui_language'") == "en-US");

                Check(
                    "the optional v3 meta keys are NOT in the required set",
                    Array.IndexOf(CacheMetaKeys.Required(), CacheMetaKeys.Units) < 0 &&
                    Array.IndexOf(CacheMetaKeys.Required(), CacheMetaKeys.UiLanguage) < 0);

                Check(
                    "NaN bounding box stored as no box at all",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM objects WHERE id = 6 AND bbox_min_x IS NULL AND bbox_max_y IS NULL")
                        == 1);

                Check(
                    "complete bounding box survives to REAL columns",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM objects WHERE id = 3 AND bbox_min_x = 1.5 AND bbox_min_y = 2.25 " +
                        "AND bbox_max_z = 2.0") == 1);

                Check(
                    "control characters and quotes survive the JSON round trip",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM properties WHERE object_id = 3 AND name = 'Name' " +
                        "AND value_text = 'Pump \"P-101\"'") == 1);

                Check(
                    "NULL and empty value_text are distinguishable in the cache",
                    Scalar(connection, "SELECT COUNT(*) FROM properties WHERE value_text IS NULL") == 1 &&
                    Scalar(connection, "SELECT COUNT(*) FROM properties WHERE value_text = ''") == 1);

                Check(
                    "properties keep encounter order per object",
                    Text(connection,
                        "SELECT group_concat(name, '|') FROM (SELECT name FROM properties WHERE object_id = 3)")
                        == "Name|Path\\Segment|Tab\tSeparated|Diameter|Volume|Tolerance|Hidden|Blank");

                Check(
                    "kind CHECK constraint accepted all three set kinds",
                    Scalar(connection, "SELECT COUNT(DISTINCT kind) FROM selection_sets") == 3);

                Check(
                    "severity CHECK constraint accepted info/warning/error",
                    Scalar(connection, "SELECT COUNT(DISTINCT severity) FROM warnings") == 3);

                // ---- schema v2: membership_resolved ----------------------------

                Check(
                    "the cache declares the schema version this build writes",
                    Text(connection, "SELECT value FROM meta WHERE key = 'schema_version'")
                        == CacheMetaKeys.CurrentSchemaVersion);

                Check(
                    "membership_resolved survives as 0/1, both values present",
                    Scalar(connection, "SELECT COUNT(*) FROM selection_sets WHERE membership_resolved = 1") == 3 &&
                    Scalar(connection, "SELECT COUNT(*) FROM selection_sets WHERE membership_resolved = 0") == 1);

                // The whole point of the column: a search set that resolved is a
                // different row from one that did not, and the resolved one may
                // carry members. Under v1 both looked identical.
                Check(
                    "a resolved search set keeps its members",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM selection_set_members m JOIN selection_sets s ON s.id = m.set_id " +
                        "WHERE s.kind = 'search' AND s.membership_resolved = 1") == 1);

                Check(
                    "an unresolved set has no member rows at all",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM selection_set_members m JOIN selection_sets s ON s.id = m.set_id " +
                        "WHERE s.membership_resolved = 0") == 0);

                // Absent membership is reported, not merely omitted: every
                // unresolved set is named by exactly one warning.
                Check(
                    "every unresolved set is covered by a SEARCH_SET_UNRESOLVED warning",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM warnings WHERE code = '" + WarningCodes.SearchSetUnresolved + "'")
                        == Scalar(connection, "SELECT COUNT(*) FROM selection_sets WHERE membership_resolved = 0"));

                // ---- schema v3: persistent identity, flags, nested models ------

                Check(
                    "authoring_id and authoring_id_kind arrive together, or not at all",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM objects WHERE (authoring_id IS NULL) <> " +
                        "(authoring_id_kind IS NULL)") == 0);

                Check(
                    "each authoring id kind survives as itself",
                    Text(connection, "SELECT authoring_id_kind FROM objects WHERE id = 3")
                        == AuthoringIdKinds.RevitElementId &&
                    Text(connection, "SELECT authoring_id_kind FROM objects WHERE id = 4")
                        == AuthoringIdKinds.IfcGlobalId &&
                    Text(connection, "SELECT authoring_id_kind FROM objects WHERE id = 6")
                        == AuthoringIdKinds.DwgHandle);

                Check(
                    "every object carries a 64-character lowercase structural key",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM objects WHERE structural_key IS NOT NULL " +
                        "AND length(structural_key) = 64 AND structural_key = lower(structural_key)")
                        == Scalar(connection, "SELECT COUNT(*) FROM objects"));

                Check(
                    "no two objects share a structural key",
                    Scalar(connection, "SELECT COUNT(DISTINCT structural_key) FROM objects")
                        == Scalar(connection, "SELECT COUNT(*) FROM objects"));

                // The bitfield is stored as one integer and read back bit by bit,
                // so a reader that asks "is this hidden" gets an answer that does
                // not depend on which other bits are set.
                Check(
                    "flags round-trip as a bitfield, not as a number that happens to match",
                    Scalar(connection, "SELECT flags FROM objects WHERE id = 4")
                        == (ObjectFlags.Hidden | ObjectFlags.Insert) &&
                    Scalar(connection, "SELECT COUNT(*) FROM objects WHERE flags & 1") == 1 &&
                    Scalar(connection, "SELECT COUNT(*) FROM objects WHERE flags & 2") == 2 &&
                    Scalar(connection, "SELECT COUNT(*) FROM objects WHERE flags & 32") == 3);

                Check(
                    "an object with no flags stores 0 rather than NULL",
                    Scalar(connection, "SELECT COUNT(*) FROM objects WHERE flags IS NULL") == 0 &&
                    Scalar(connection, "SELECT flags FROM objects WHERE id = 6") == 0);

                Check(
                    "source models keep their converted-from file name and GUID",
                    Text(connection, "SELECT source_file_name FROM source_models WHERE id = 1")
                        == "SYNTHETIC-PLANT-A.rvt" &&
                    Text(connection, "SELECT source_guid FROM source_models WHERE id = 1")
                        == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" &&
                    Text(connection, "SELECT source_file_name FROM source_models WHERE id = 2") == null);

                // A model appended inside another is a child row, and the objects
                // under it belong to the child rather than to its host.
                Check(
                    "a nested appended model is a child of the model it was appended into",
                    Scalar(connection, "SELECT parent_id FROM source_models WHERE id = 3") == 2 &&
                    Scalar(connection, "SELECT source_model_id FROM objects WHERE id = 8") == 3 &&
                    Scalar(connection, "SELECT source_model_id FROM objects WHERE id = 7") == 2);

                Check(
                    "selection sets keep their own GUID, and a set without one is NULL",
                    Scalar(connection, "SELECT COUNT(*) FROM selection_sets WHERE guid IS NOT NULL") == 3 &&
                    Text(connection, "SELECT guid FROM selection_sets WHERE id = 4") == null);

                // The launcher refuses to commit a cache built from a stream that
                // carried one of these; the row itself still has to survive, or
                // the failure would have nothing to name.
                Check(
                    "a SOURCE_MODEL_MISSING warning is recorded at error severity",
                    Scalar(
                        connection,
                        "SELECT COUNT(*) FROM warnings WHERE severity = 'error' AND code = '" +
                        WarningCodes.SourceModelMissing + "'") == 1);
            }
        }

        /// <summary>
        /// The cache is written with foreign keys OFF (they cost time and the
        /// writer controls insert order). This turns them on afterwards and asks
        /// SQLite whether the finished file would have satisfied them anyway.
        /// </summary>
        private static void CheckReferentialIntegrity(string cachePath)
        {
            using (SqliteConnection connection = OpenReadOnly(cachePath))
            {
                using (SqliteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "PRAGMA foreign_keys = ON";
                    command.ExecuteNonQuery();
                }

                List<string> violations = new List<string>();
                using (SqliteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "PRAGMA foreign_key_check";
                    using (SqliteDataReader reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            violations.Add(reader.GetString(0) + " rowid " + reader.GetValue(1));
                        }
                    }
                }

                Check(
                    "no dangling foreign keys in the committed cache",
                    violations.Count == 0,
                    string.Join(", ", violations.ToArray()));

                using (SqliteCommand command = connection.CreateCommand())
                {
                    command.CommandText = "PRAGMA integrity_check";
                    object result = command.ExecuteScalar();
                    Check(
                        "SQLite integrity_check",
                        result != null && string.Equals(result.ToString(), "ok", StringComparison.Ordinal),
                        result == null ? "null" : result.ToString());
                }
            }
        }

        private static void CheckInspectorAcceptsIt(string cachePath, long objectCount)
        {
            CacheValidation validation = CacheInspector.Validate(cachePath);
            Check("CacheInspector accepts the cache", validation.IsValid, validation.Reason);
            Check("CacheInspector object count", validation.ObjectCount == objectCount);
            Check("CacheInspector warning count", validation.WarningCount == 5);
        }

        /// <summary>
        /// CacheSchema.Ddl documents itself as a verbatim copy of the canonical
        /// DDL. This is what makes that claim checkable rather than aspirational.
        /// It also proves the compiler read this repo's UTF-8 sources correctly:
        /// a mangled encoding shows up here as a byte mismatch.
        /// </summary>
        private static void CheckSchemaIsVerbatim()
        {
            string canonicalPath = FindCanonicalSchema();
            if (canonicalPath == null)
            {
                Check("canonical schemas/extraction-cache.sql found", false, "not found above the smoke project");
                return;
            }

            string canonical = File.ReadAllText(canonicalPath, new UTF8Encoding(false));
            string embedded = CacheSchema.Ddl;

            // The C# literal opens with a newline purely so the SQL starts in
            // column 1; everything after it must match byte for byte.
            if (embedded.StartsWith("\n", StringComparison.Ordinal))
            {
                embedded = embedded.Substring(1);
            }

            bool same = string.Equals(canonical, embedded, StringComparison.Ordinal);
            Check(
                "CacheSchema.Ddl is byte-verbatim against schemas/extraction-cache.sql",
                same,
                same ? null : FirstDifference(canonical, embedded));
        }

        private static string FindCanonicalSchema()
        {
            DirectoryInfo directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                string candidate = Path.Combine(directory.FullName, "schemas", "extraction-cache.sql");
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                directory = directory.Parent;
            }

            return null;
        }

        private static string FirstDifference(string left, string right)
        {
            int limit = Math.Min(left.Length, right.Length);
            for (int i = 0; i < limit; i++)
            {
                if (left[i] != right[i])
                {
                    return "first difference at offset " + i.ToString(CultureInfo.InvariantCulture) +
                        ": canonical U+" + ((int)left[i]).ToString("X4", CultureInfo.InvariantCulture) +
                        " vs embedded U+" + ((int)right[i]).ToString("X4", CultureInfo.InvariantCulture);
                }
            }

            return "lengths differ: canonical " + left.Length + ", embedded " + right.Length;
        }

        // ------------------------------------------------------------ plumbing

        private static SqliteConnection OpenReadOnly(string path)
        {
            SqliteConnectionStringBuilder builder = new SqliteConnectionStringBuilder();
            builder.DataSource = path;
            builder.Mode = SqliteOpenMode.ReadOnly;
            builder.Pooling = false;

            SqliteConnection connection = new SqliteConnection(builder.ToString());
            connection.Open();
            return connection;
        }

        private static long Scalar(SqliteConnection connection, string sql)
        {
            using (SqliteCommand command = connection.CreateCommand())
            {
                command.CommandText = sql;
                object value = command.ExecuteScalar();
                if (value == null || value == DBNull.Value)
                {
                    return -1;
                }

                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
        }

        private static string Text(SqliteConnection connection, string sql)
        {
            using (SqliteCommand command = connection.CreateCommand())
            {
                command.CommandText = sql;
                object value = command.ExecuteScalar();
                return value == null || value == DBNull.Value ? null : value.ToString();
            }
        }

        private static int CountKind(List<StreamItem> items, ItemKind kind)
        {
            int count = 0;
            for (int i = 0; i < items.Count; i++)
            {
                if (items[i].Kind == kind)
                {
                    count++;
                }
            }

            return count;
        }

        private static int CountBytes(byte[] bytes, byte value)
        {
            int count = 0;
            for (int i = 0; i < bytes.Length; i++)
            {
                if (bytes[i] == value)
                {
                    count++;
                }
            }

            return count;
        }

        private static void Delete(string path)
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }

        private static bool Check(string what, bool condition)
        {
            return Check(what, condition, null);
        }

        private static bool Check(string what, bool condition, string detail)
        {
            _checks++;
            if (condition)
            {
                return true;
            }

            Failures.Add(what + (string.IsNullOrEmpty(detail) ? string.Empty : " (" + detail + ")"));
            return false;
        }

        private static void Same(string what, string expected, string actual)
        {
            Check(what, string.Equals(expected, actual, StringComparison.Ordinal),
                Show(expected) + " != " + Show(actual));
        }

        private static void Same(string what, long expected, long actual)
        {
            Check(what, expected == actual, expected + " != " + actual);
        }

        private static void Same(string what, long? expected, long? actual)
        {
            Check(what, expected == actual,
                (expected.HasValue ? expected.Value.ToString(CultureInfo.InvariantCulture) : "null") + " != " +
                (actual.HasValue ? actual.Value.ToString(CultureInfo.InvariantCulture) : "null"));
        }

        private static void Same(string what, bool expected, bool actual)
        {
            Check(what, expected == actual, expected + " != " + actual);
        }

        /// <summary>
        /// Bounding boxes compare after the reader's all-or-none rule: a written
        /// box containing NaN is expected to come back as no box.
        /// </summary>
        private static void SameBox(string what, double[] expected, double[] actual)
        {
            double[] normalised = expected;
            if (normalised != null)
            {
                for (int i = 0; i < normalised.Length; i++)
                {
                    if (double.IsNaN(normalised[i]) || double.IsInfinity(normalised[i]))
                    {
                        normalised = null;
                        break;
                    }
                }
            }

            if (normalised == null || actual == null)
            {
                Check(what, normalised == null && actual == null,
                    (normalised == null ? "null" : "box") + " != " + (actual == null ? "null" : "box"));
                return;
            }

            bool same = normalised.Length == actual.Length;
            for (int i = 0; same && i < normalised.Length; i++)
            {
                // Bit-exact: "R" formatting is supposed to be lossless.
                same = normalised[i].Equals(actual[i]);
            }

            Check(what, same);
        }

        private static string Show(string value)
        {
            if (value == null)
            {
                return "null";
            }

            return "\"" + value.Replace("\n", "\\n").Replace("\t", "\\t").Replace("\r", "\\r") + "\"";
        }
    }
}
