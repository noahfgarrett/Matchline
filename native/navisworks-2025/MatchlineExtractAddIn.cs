using System;
using System.Globalization;
using System.IO;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Plugins;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Navisworks2025
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
    /// UNVERIFIED AGAINST THE REAL API. Every Autodesk call in this project was
    /// written on a machine with no Navisworks and no .NET SDK. The first build
    /// on Windows is part of the Phase 1 proof, not a formality. Points of real
    /// uncertainty carry a // VERIFY-ON-WINDOWS: comment; they are collected in
    /// docs/WINDOWS-RUNBOOK.md as a checklist.
    /// ---------------------------------------------------------------------
    /// </summary>
    // VERIFY-ON-WINDOWS: PluginAttribute signature is (name, developerId, ...)
    // and the command-line id is "name.developerId". Confirm the plugin is
    // discovered at all before debugging anything else.
    [Plugin(ExtractionPlugin.Name, ExtractionPlugin.DeveloperId,
        DisplayName = "Matchline Extract",
        ToolTip = "Streams model metadata to an NDJSON file")]
    // VERIFY-ON-WINDOWS: AddInLocation.AddIn is used because it certainly
    // exists. If the enum has a "None" member, prefer it -- this plugin should
    // never appear in the ribbon.
    [AddInPlugin(AddInLocation.AddIn)]
    public sealed class MatchlineExtractAddIn : AddInPlugin
    {
        /// <summary>Stamped into meta.adapter_version.</summary>
        public const string AdapterVersion = "navisworks-2025";

        private const int ExitOk = 0;
        private const int ExitFailed = 1;
        private const int ExitBadParameters = 2;

        public override int Execute(params string[] parameters)
        {
            string outputPath = parameters != null && parameters.Length > 0 ? parameters[0] : null;
            string inputPath = parameters != null && parameters.Length > 1 ? parameters[1] : null;

            if (string.IsNullOrEmpty(outputPath))
            {
                // Nowhere to write, so nowhere to report. The launcher sees an
                // absent stream file and reports EXTRACT_FAILED.
                return ExitBadParameters;
            }

            NdjsonWriter writer = null;
            try
            {
                writer = NdjsonWriter.CreateFile(outputPath);

                Document document = PrepareDocument(inputPath);
                WriteHeaderMeta(writer, document, inputPath);

                DocumentWalker walker = new DocumentWalker(writer);
                walker.Walk(document);

                EndRecord end = new EndRecord();
                end.Ok = true;
                end.ObjectCount = walker.ObjectCount;
                end.WarningCount = walker.WarningCount;
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
                // VERIFY-ON-WINDOWS: Document.TryOpenFile(string) returning bool.
                // If the API differs, the alternatives are OpenFile / TryOpenFile
                // with extra arguments.
                bool opened = document.TryOpenFile(inputPath);
                if (!opened)
                {
                    throw new InvalidOperationException(
                        "Navisworks could not open the file: " + Path.GetFileName(inputPath));
                }
            }

            if (document.Models.Count == 0)
            {
                throw new InvalidOperationException(
                    "The active document contains no models; nothing was opened.");
            }

            return document;
        }

        private static void WriteHeaderMeta(NdjsonWriter writer, Document document, string inputPath)
        {
            writer.WriteMeta(CacheMetaKeys.AdapterVersion, AdapterVersion);
            writer.WriteMeta(CacheMetaKeys.NavisworksVersion, NavisworksVersionString());

            // File name only, never a directory (EXTRACTION.md, confidentiality).
            string fileName = null;
            if (!string.IsNullOrEmpty(inputPath))
            {
                fileName = Path.GetFileName(inputPath);
            }
            else if (!string.IsNullOrEmpty(document.FileName))
            {
                // VERIFY-ON-WINDOWS: Document.FileName exists and holds the path
                // of the currently open file.
                fileName = Path.GetFileName(document.FileName);
            }

            if (!string.IsNullOrEmpty(fileName))
            {
                writer.WriteMeta(CacheMetaKeys.InputFileName, fileName);
            }
        }

        /// <summary>
        /// Product version string, read reflectively.
        /// <para>
        /// Deliberate: the shape of Application.Version differs across releases
        /// and this value is descriptive metadata, not control flow. Reflection
        /// keeps a wrong guess from being a compile error on an unbuildable-here
        /// project. VERIFY-ON-WINDOWS: check what this actually produces and
        /// consider replacing it with the direct property once confirmed.
        /// </para>
        /// </summary>
        private static string NavisworksVersionString()
        {
            try
            {
                System.Reflection.PropertyInfo property = typeof(Application).GetProperty(
                    "Version",
                    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
                if (property == null)
                {
                    return "unknown";
                }

                object value = property.GetValue(null, null);
                if (value == null)
                {
                    return "unknown";
                }

                string text = value.ToString();
                return string.IsNullOrEmpty(text) ? "unknown" : text;
            }
            catch (Exception)
            {
                return "unknown";
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
                end.Message = Describe(ex);
                writer.WriteEnd(end);
            }
            catch (Exception)
            {
                // The stream is already lost; the launcher's "no end record"
                // path covers this.
            }
        }

        private static string Describe(Exception ex)
        {
            if (ex == null)
            {
                return "unknown failure";
            }

            return string.Format(
                CultureInfo.InvariantCulture,
                "{0}: {1}",
                ex.GetType().Name,
                ex.Message);
        }
    }
}
