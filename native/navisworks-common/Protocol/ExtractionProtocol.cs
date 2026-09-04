namespace Matchline.Extraction.Protocol
{
    /// <summary>
    /// Identity of the Navisworks AddInPlugin. The adapter stamps these values
    /// into its [Plugin] attribute and the launcher builds the
    /// -ExecuteAddInPlugin argument from <see cref="CommandLineId"/>, so the two
    /// sides cannot disagree about the name.
    /// </summary>
    public static class ExtractionPlugin
    {
        public const string Name = "MatchlineExtract";

        /// <summary>
        /// Autodesk developer id (four characters by convention). VERIFY-ON-WINDOWS:
        /// Navisworks may require this id to be registered/whitelisted for the
        /// plugin to load; if discovery fails, this is the first thing to check.
        /// </summary>
        public const string DeveloperId = "MTCH";

        /// <summary>What -ExecuteAddInPlugin expects: "Name.DeveloperId".</summary>
        public const string CommandLineId = Name + "." + DeveloperId;
    }

    /// <summary>Stage names for the launcher's progress lines.</summary>
    public static class ExtractionStages
    {
        public const string Hash = "hash";

        /// <summary>
        /// Which installed Navisworks was chosen. Its progress line carries a
        /// <c>detail</c> string naming the product, year and install folder that
        /// will open the file, so a run is never ambiguous about which version
        /// produced the cache.
        /// </summary>
        public const string Detect = "detect";

        public const string Open = "open";
        public const string Walk = "walk";

        /// <summary>
        /// Saved-set resolution, reported per set.
        /// <para>
        /// Its own stage because a saved search is not part of the tree walk and
        /// does not cost what the walk costs: resolving one re-runs the search
        /// over the whole model, so a document with a few dozen of them can sit
        /// here for minutes after the last object record was written. Without
        /// this line the walk counter simply stops moving and the run looks
        /// hung. Unlike walk and convert this stage knows its total, because the
        /// set tree is counted before the first one is resolved.
        /// </para>
        /// </summary>
        public const string Sets = "sets";

        public const string Convert = "convert";
        public const string Finalize = "finalize";
    }

    /// <summary>
    /// Error codes emitted on the launcher's stdout. The first four are named in
    /// EXTRACTION.md and are load-bearing for UI messaging; the rest are the
    /// documented "..." tail of that list.
    /// </summary>
    public static class ExtractionErrorCodes
    {
        /// <summary>NWD published by a newer Navisworks than the installed adapter.</summary>
        public const string NavisworksVersionTooNew = "NW_VERSION_TOO_NEW";

        /// <summary>No licensed Navisworks Manage/Simulate install found.</summary>
        public const string NavisworksNotInstalled = "NW_NOT_INSTALLED";

        /// <summary>Navisworks could not open the file, for any other reason.</summary>
        public const string OpenFailed = "OPEN_FAILED";

        /// <summary>A "cancel" line arrived on stdin.</summary>
        public const string Cancelled = "CANCELLED";

        public const string InvalidArguments = "INVALID_ARGS";
        public const string InputNotFound = "INPUT_NOT_FOUND";

        /// <summary>The plugin ran but did not produce a complete stream.</summary>
        public const string ExtractFailed = "EXTRACT_FAILED";

        /// <summary>
        /// Navisworks stopped making progress and was killed.
        /// <para>
        /// Distinct from EXTRACT_FAILED because the cause is almost never the
        /// model: a headless Navisworks that has stopped writing to the stream
        /// is usually sitting behind a modal dialog nobody can see -- a sign-in,
        /// a licence prompt, or the autosave-recovery box after a previous run
        /// was killed. The launcher cannot dismiss it, so it says so.
        /// </para>
        /// </summary>
        public const string NavisworksStalled = "NW_STALLED";

        /// <summary>
        /// The extraction plugin is not in the Plugins folder of the install
        /// that would open the file. Decided before Navisworks is started.
        /// </summary>
        public const string PluginNotDeployed = "PLUGIN_NOT_DEPLOYED";

        /// <summary>
        /// Navisworks ran and exited without the plugin ever creating the
        /// stream file. Distinct from EXTRACT_FAILED, which is a stream that
        /// started and did not finish.
        /// </summary>
        public const string PluginNotFound = "PLUGIN_NOT_FOUND";

        /// <summary>
        /// The document opened without one or more of the files it references,
        /// or a model-level read failed outright, so the stream describes less
        /// than the input does.
        /// <para>
        /// Its own code because the run looks like a success from every other
        /// angle: Navisworks opened, the walk finished, the terminator arrived,
        /// and the cache would have committed cleanly -- describing a model with
        /// a whole discipline silently missing. An NWF whose references have
        /// moved is the usual cause, which is why the launcher never serves a
        /// cached answer for an NWF without re-opening it.
        /// </para>
        /// </summary>
        public const string SourceModelMissing = "SOURCE_MODEL_MISSING";

        /// <summary>The stream was complete but the cache could not be written or verified.</summary>
        public const string CacheWriteFailed = "CACHE_WRITE_FAILED";

        public const string Internal = "INTERNAL";
    }

    /// <summary>
    /// Required <c>meta</c> keys, per schemas/extraction-cache.sql. The cache
    /// writer refuses to commit unless every one of these is present.
    /// </summary>
    public static class CacheMetaKeys
    {
        public const string SchemaVersion = "schema_version";
        public const string InputFileName = "input_file_name";
        public const string InputSha256 = "input_sha256";
        public const string InputBytes = "input_bytes";
        public const string ExtractedAtUtc = "extracted_at_utc";
        public const string ExtractorVersion = "extractor_version";
        public const string AdapterVersion = "adapter_version";
        public const string NavisworksVersion = "navisworks_version";
        public const string ObjectCount = "object_count";

        /// <summary>
        /// <c>meta.units</c>: the document's display units, as the API names
        /// them. Optional, and deliberately NOT in <see cref="Required"/> --
        /// every cache written before schema v3 lacks it, and refusing those
        /// would make the key a breaking change rather than an addition.
        /// </summary>
        public const string Units = "units";

        /// <summary>
        /// <c>meta.ui_language</c>: the UI culture the extraction ran under.
        /// Optional, for the same reason as <see cref="Units"/>. It matters
        /// because Navisworks localises property and category DISPLAY names, so
        /// a catalog built from a de-DE extraction and one built from an en-US
        /// extraction of the same model do not name the same things.
        /// </summary>
        public const string UiLanguage = "ui_language";

        /// <summary>
        /// The schema version this build writes. Bumped to 3 when objects gained
        /// authoring_id_kind, structural_key and flags, source_models gained
        /// source_file_name and source_guid, and selection_sets gained guid; the
        /// reader half of that bump lives in packages/model-schema, which still
        /// accepts 1 and 2.
        /// </summary>
        public const string CurrentSchemaVersion = "3";

        public static string[] Required()
        {
            return new string[]
            {
                SchemaVersion,
                InputFileName,
                InputSha256,
                InputBytes,
                ExtractedAtUtc,
                ExtractorVersion,
                AdapterVersion,
                NavisworksVersion,
                ObjectCount
            };
        }
    }
}
