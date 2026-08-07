using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// Process exit codes. Distinct per failure class so a caller that cannot
    /// parse stdout (a shell, a CI step) still learns what went wrong.
    /// </summary>
    internal static class ExitCodes
    {
        internal const int Ok = 0;
        internal const int Internal = 1;
        internal const int InvalidArguments = 2;
        internal const int InputNotFound = 3;
        internal const int NavisworksNotInstalled = 4;
        internal const int NavisworksVersionTooNew = 5;
        internal const int OpenFailed = 6;
        internal const int ExtractFailed = 7;
        internal const int CacheWriteFailed = 8;
        internal const int Cancelled = 9;

        internal static int ForErrorCode(string code)
        {
            switch (code)
            {
                case ExtractionErrorCodes.InvalidArguments:
                    return InvalidArguments;
                case ExtractionErrorCodes.InputNotFound:
                    return InputNotFound;
                case ExtractionErrorCodes.NavisworksNotInstalled:
                    return NavisworksNotInstalled;
                case ExtractionErrorCodes.NavisworksVersionTooNew:
                    return NavisworksVersionTooNew;
                case ExtractionErrorCodes.OpenFailed:
                    return OpenFailed;
                case ExtractionErrorCodes.ExtractFailed:
                    return ExtractFailed;
                case ExtractionErrorCodes.CacheWriteFailed:
                    return CacheWriteFailed;
                case ExtractionErrorCodes.Cancelled:
                    return Cancelled;
                default:
                    return Internal;
            }
        }
    }
}
