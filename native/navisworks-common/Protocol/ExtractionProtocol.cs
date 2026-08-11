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

        /// <summary>The schema version this build reads and writes.</summary>
        public const string CurrentSchemaVersion = "1";

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
