using System;
using System.IO;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Plugins;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.NavisworksAdapter
{
    /// <summary>
    /// Headless extraction plugin. Navisworks is started by the launcher with
    /// the NWD on its command line and this plugin id after
    /// -ExecuteAddInPlugin; the plugin walks the open document and streams
    /// NDJSON to the path it is handed.
    ///
    /// Parameters (in order):
    ///   [0] output NDJSON path (required)
    ///   [1] input NWD path (optional; used only as a fallback open and for meta)
    ///
    /// ---------------------------------------------------------------------
    /// This file is compiled once per supported Navisworks year, into
    /// Matchline.Extraction.Navisworks2024/2025/2026. The only per-year source
    /// is AdapterIdentity.cs, which carries the year and nothing else. See
    /// native/README.md.
    ///
    /// UNVERIFIED AGAINST THE REAL API. Every Autodesk call in this directory
    /// was written on a machine with no Navisworks. It compiles, but only
    /// against native/navisworks-stubs, a hand-written stand-in whose signatures
    /// were derived from this code rather than from Autodesk. So the compiler
    /// has checked that the plugin is internally consistent, not that it is
    /// right. The first build on Windows is still part of the Phase 1 proof.
    /// Each // VERIFY-ON-WINDOWS: comment says whether the stub pins its shape
    /// or leaves it fully open; docs/WINDOWS-RUNBOOK.md is the checklist.
    /// ---------------------------------------------------------------------
    /// </summary>
    // VERIFY-ON-WINDOWS (shape pinned by the stub build: PluginAttribute takes
    // two positional strings and has settable DisplayName and ToolTip). NOT
    // pinned, and it is the part that actually fails silently: that the
    // command-line id Navisworks expects is "name.developerId". Confirm the
    // plugin is discovered at all before debugging anything else.
    //
    // The id is deliberately the same for every year: one Matchline adapter is
    // deployed into one Navisworks install, so the ids never meet. Two adapters
    // dropped into the same Plugins folder would collide, which is why the
    // runbook deploys the folder whose name matches the assembly for that year.
    [Plugin(ExtractionPlugin.Name, ExtractionPlugin.DeveloperId,
        DisplayName = "Matchline Extract",
        ToolTip = "Streams model metadata to an NDJSON file")]
    // VERIFY-ON-WINDOWS (shape pinned by the stub build: AddInPluginAttribute
    // takes one positional AddInLocation, and AddInLocation.AddIn exists there
    // because this line names it). FULLY OPEN: whether the real enum has a
    // "None" member. It would be the better choice -- this plugin should never
    // appear in the ribbon -- and the stub deliberately does not declare one,
    // because inventing it would fake the answer.
    [AddInPlugin(AddInLocation.AddIn)]
    public sealed class MatchlineExtractAddIn : AddInPlugin
    {
        /// <summary>Stamped into meta.adapter_version, e.g. "navisworks-2025".</summary>
        internal static string AdapterVersion
        {
            get { return SupportedAdapters.AdapterVersionForYear(AdapterIdentity.Year); }
        }

        public override int Execute(params string[] parameters)
        {
            string outputPath = parameters != null && parameters.Length > 0 ? parameters[0] : null;
            string inputPath = parameters != null && parameters.Length > 1 ? parameters[1] : null;

            // Stream lifetime, the terminator record and failure classification
            // are identical for every year and live in the Autodesk-free half.
            return ExtractionSession.Run(outputPath, new Workload(inputPath));
        }

        /// <summary>
        /// The Autodesk-touching part, and the only part: open the document,
        /// name it in the header, walk it.
        /// </summary>
        private sealed class Workload : IExtractionWorkload
        {
            private readonly string _inputPath;

            internal Workload(string inputPath)
            {
                _inputPath = inputPath;
            }

            public ExtractionCounts Run(NdjsonWriter writer)
            {
                Document document = PrepareDocument(_inputPath);

                ExtractionHeader.Write(
                    writer,
                    AdapterVersion,
                    ProductVersion(),
                    _inputPath,
                    DocumentPath(document));

                DocumentWalker walker = new DocumentWalker(writer);
                walker.Walk(document);
                return new ExtractionCounts(walker.ObjectCount, walker.WarningCount);
            }
        }

        /// <summary>
        /// Returns the document to walk. Navisworks normally has the file open
        /// already (it was passed on the command line); the fallback open exists
        /// so a command-line convention change degrades into a clear error
        /// rather than an empty cache.
        /// </summary>
        private static Document PrepareDocument(string inputPath)
        {
            Document document = Application.ActiveDocument;
            if (document == null)
            {
                throw new InvalidOperationException("Navisworks reported no active document.");
            }

            if (document.Models.Count == 0 && !string.IsNullOrEmpty(inputPath))
            {
                // OpenFile rather than TryOpenFile, and the difference is the
                // whole point: TryOpenFile answers a bool and throws Navisworks's
                // own message away, which is the one sentence that can say the
                // file was published by a newer release. Without it
                // NW_VERSION_TOO_NEW was unreachable -- the launcher classifies
                // from text, a headless GUI executable writes none, and the
                // adapter's own "could not open" was classified OPEN_FAILED and
                // never revisited (docs/DECISIONS.md calls the too-new message
                // mandatory).
                //
                // VERIFY-ON-WINDOWS (shape pinned by the stub build: OpenFile
                // takes one string and returns nothing). If the real API needs
                // more arguments, add them here; the try/catch stays either way.
                try
                {
                    document.OpenFile(inputPath);
                }
                catch (Exception ex)
                {
                    // Navisworks's own words are carried into the message, and
                    // FailureClassifier reads the whole of it: the too-new
                    // fragments are checked before the "could not open" ones, so
                    // a version failure keeps its own code and everything else
                    // still falls back to OPEN_FAILED.
                    throw new InvalidOperationException(
                        "Navisworks could not open the file: " + Path.GetFileName(inputPath) +
                        " -- " + FailureClassifier.Describe(ex),
                        ex);
                }
            }

            if (document.Models.Count == 0)
            {
                throw new InvalidOperationException(
                    "The active document contains no models; nothing was opened.");
            }

            return document;
        }

        /// <summary>
        /// Path of the open document, or null. Only ever used to derive a file
        /// name; ExtractionHeader is what enforces that no directory is recorded.
        /// </summary>
        private static string DocumentPath(Document document)
        {
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // Document.FileName is a string property). NOT pinned: that it
                // holds the path of the currently open file.
                return document.FileName;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Product version string, read reflectively.
        /// <para>
        /// Deliberate: the shape of Application.Version differs across releases
        /// and this value is descriptive metadata, not control flow. Reflection
        /// keeps a wrong guess from being a compile error, and keeps this file
        /// identical for 2024, 2025 and 2026. VERIFY-ON-WINDOWS (FULLY OPEN): a
        /// reflective lookup is invisible to the compiler, so the stub build says
        /// nothing here. Check what this actually produces on each year, and
        /// consider replacing it with the direct property once confirmed.
        /// </para>
        /// </summary>
        private static string ProductVersion()
        {
            string version = ReflectionProbe.ReadString(
                typeof(Application), null, new string[] { "Version" }, null);

            return version ?? ExtractionHeader.UnknownProductVersion;
        }
    }
}
