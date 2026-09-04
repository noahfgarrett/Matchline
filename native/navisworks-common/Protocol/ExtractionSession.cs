using System;
using System.Globalization;
using System.IO;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Protocol
{
    /// <summary>Totals the terminator record carries.</summary>
    public sealed class ExtractionCounts
    {
        private readonly long _objectCount;
        private readonly long _warningCount;

        public ExtractionCounts(long objectCount, long warningCount)
        {
            _objectCount = objectCount;
            _warningCount = warningCount;
        }

        public long ObjectCount
        {
            get { return _objectCount; }
        }

        public long WarningCount
        {
            get { return _warningCount; }
        }
    }

    /// <summary>
    /// The Autodesk-touching half of one extraction: write the header meta and
    /// every record, and say how many objects and warnings that came to.
    /// <para>
    /// This is the whole seam between the version adapters and everything else.
    /// A version adapter implements this and nothing more; stream lifetime,
    /// terminator, failure classification and exit codes are
    /// <see cref="ExtractionSession"/>'s job and are identical for every year.
    /// </para>
    /// </summary>
    public interface IExtractionWorkload
    {
        ExtractionCounts Run(NdjsonWriter writer);
    }

    /// <summary>
    /// Runs a workload into an NDJSON file: create the stream, run the walk,
    /// terminate it, and turn any failure into an <c>end</c> record the launcher
    /// can classify.
    /// <para>
    /// Autodesk-free on purpose. Every version adapter's <c>Execute</c> is a call
    /// to this, so no year can drift into a different failure policy: exactly one
    /// terminator per run, a failure always reported in-stream (a plugin's return
    /// value is not reliably visible to the process that launched Navisworks),
    /// and the writer always disposed.
    /// </para>
    /// </summary>
    public static class ExtractionSession
    {
        /// <summary>The walk finished and the stream is complete.</summary>
        public const int ExitOk = 0;

        /// <summary>Something failed; the stream carries an <c>end</c> record saying what.</summary>
        public const int ExitFailed = 1;

        /// <summary>
        /// No output path, so there is nowhere to report. The launcher sees an
        /// absent stream file and reports EXTRACT_FAILED.
        /// </summary>
        public const int ExitBadParameters = 2;

        public static int Run(string outputPath, IExtractionWorkload workload)
        {
            if (workload == null)
            {
                throw new ArgumentNullException("workload");
            }

            if (string.IsNullOrEmpty(outputPath))
            {
                return ExitBadParameters;
            }

            NdjsonWriter writer = null;
            try
            {
                writer = NdjsonWriter.CreateFile(outputPath);

                ExtractionCounts counts = workload.Run(writer);

                EndRecord end = new EndRecord();
                end.Ok = true;
                end.ObjectCount = counts == null ? 0 : counts.ObjectCount;
                end.WarningCount = counts == null ? 0 : counts.WarningCount;
                writer.WriteEnd(end);
                return ExitOk;
            }
            catch (Exception ex)
            {
                TryWriteFailure(writer, ex);
                return ExitFailed;
            }
            finally
            {
                if (writer != null)
                {
                    writer.Dispose();
                }
            }
        }

        private static void TryWriteFailure(NdjsonWriter writer, Exception ex)
        {
            if (writer == null)
            {
                return;
            }

            try
            {
                EndRecord end = new EndRecord();
                end.Ok = false;
                end.Code = FailureClassifier.ClassifyException(ex, ExtractionErrorCodes.ExtractFailed);
                end.Message = FailureClassifier.Describe(ex);
                writer.WriteEnd(end);
            }
            catch (Exception)
            {
                // The stream is already lost; the launcher's "no end record" path
                // covers this.
            }
        }
    }

    /// <summary>
    /// The <c>meta</c> lines every adapter writes before its first record.
    /// <para>
    /// One implementation for every year, because two of the three values are
    /// policy rather than API: the adapter version spelling comes from
    /// <see cref="SupportedAdapters"/>, and the input is recorded as a file
    /// *name* only -- a directory would leak local paths into a portable cache
    /// (docs/EXTRACTION.md, confidentiality).
    /// </para>
    /// </summary>
    public static class ExtractionHeader
    {
        /// <summary>What <c>meta.navisworks_version</c> says when the product will not name itself.</summary>
        public const string UnknownProductVersion = "unknown";

        /// <param name="preferredPath">Path the launcher handed the plugin; may be null.</param>
        /// <param name="fallbackPath">Path the open document reports; used only when the first is absent.</param>
        /// <param name="units">
        /// <c>Document.Units</c> as the API names it, or null when the document
        /// would not say. Written as <c>meta.units</c>, which is optional: a
        /// cache without it is a cache from an older adapter, not a broken one.
        /// </param>
        public static void Write(
            NdjsonWriter writer,
            string adapterVersion,
            string productVersion,
            string preferredPath,
            string fallbackPath,
            string units)
        {
            if (writer == null)
            {
                throw new ArgumentNullException("writer");
            }

            writer.WriteMeta(CacheMetaKeys.AdapterVersion, adapterVersion);
            writer.WriteMeta(
                CacheMetaKeys.NavisworksVersion,
                string.IsNullOrEmpty(productVersion) ? UnknownProductVersion : productVersion);

            if (!string.IsNullOrEmpty(units))
            {
                writer.WriteMeta(CacheMetaKeys.Units, units);
            }

            // Read here rather than passed in: it is a .NET fact, not an
            // Autodesk one, and every year would otherwise spell it separately.
            // It is recorded because Navisworks localises property and category
            // DISPLAY names, so the language a cache was extracted under is part
            // of what its property catalog means.
            string uiLanguage = UiLanguage();
            if (!string.IsNullOrEmpty(uiLanguage))
            {
                writer.WriteMeta(CacheMetaKeys.UiLanguage, uiLanguage);
            }

            string fileName = FileNameOnly(preferredPath);
            if (string.IsNullOrEmpty(fileName))
            {
                fileName = FileNameOnly(fallbackPath);
            }

            if (!string.IsNullOrEmpty(fileName))
            {
                writer.WriteMeta(CacheMetaKeys.InputFileName, fileName);
            }
        }

        /// <summary>
        /// The UI culture this extraction ran under, e.g. "en-US". Null when the
        /// runtime will not name one -- the invariant culture answers an empty
        /// string, which is not a language.
        /// </summary>
        private static string UiLanguage()
        {
            try
            {
                CultureInfo culture = CultureInfo.CurrentUICulture;
                if (culture == null)
                {
                    return null;
                }

                string name = culture.Name;
                return string.IsNullOrEmpty(name) ? null : name;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// File name, never a directory. Returns null for anything unusable --
        /// on .NET Framework a path with invalid characters throws here, and a
        /// malformed path must not cost the whole extraction.
        /// </summary>
        private static string FileNameOnly(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return null;
            }

            try
            {
                return Path.GetFileName(path);
            }
            catch (ArgumentException)
            {
                return null;
            }
        }
    }
}
