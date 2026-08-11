using System;

namespace Matchline.Extraction.Protocol
{
    /// <summary>
    /// Maps a Navisworks failure message onto one of the documented error codes.
    /// <para>
    /// The forward-compatibility case is the one that matters: an NWD published
    /// by a newer Navisworks than the installed adapter must surface as
    /// NW_VERSION_TOO_NEW, never as a generic open failure (EXTRACTION.md).
    /// Navisworks reports this as an "unknown version number" style open error.
    /// </para>
    /// <para>
    /// VERIFY-ON-WINDOWS: the exact wording Navisworks 2025 produces for a
    /// too-new NWD has not been observed yet. During the proof run, capture the
    /// verbatim message and make sure one of the fragments below matches it;
    /// add the real wording if none does.
    /// </para>
    /// </summary>
    public static class FailureClassifier
    {
        private static readonly string[] VersionTooNewFragments =
        {
            "unknown version",
            "newer version",
            "unsupported version",
            "unsupported file version",
            "created by a newer",
            "requires a newer"
        };

        private static readonly string[] OpenFailedFragments =
        {
            "could not open",
            "cannot open",
            "failed to open",
            "unhandled file format",
            "file format",
            "is not a valid",
            "corrupt"
        };

        /// <summary>
        /// Returns a code from <see cref="ExtractionErrorCodes"/>, or
        /// <paramref name="fallback"/> when nothing matches.
        /// </summary>
        public static string ClassifyMessage(string message, string fallback)
        {
            if (string.IsNullOrEmpty(message))
            {
                return fallback;
            }

            if (ContainsAny(message, VersionTooNewFragments))
            {
                return ExtractionErrorCodes.NavisworksVersionTooNew;
            }

            if (ContainsAny(message, OpenFailedFragments))
            {
                return ExtractionErrorCodes.OpenFailed;
            }

            return fallback;
        }

        /// <summary>
        /// The one spelling of "what went wrong" used everywhere in the native
        /// half: type name and message, no stack trace. A stack trace would be
        /// the only thing here that could carry a local path into a cache or a
        /// protocol line.
        /// </summary>
        public static string Describe(Exception exception)
        {
            if (exception == null)
            {
                return "unknown failure";
            }

            return exception.GetType().Name + ": " + exception.Message;
        }

        public static string ClassifyException(Exception exception, string fallback)
        {
            if (exception == null)
            {
                return fallback;
            }

            string message = exception.Message;
            Exception inner = exception.InnerException;
            while (inner != null)
            {
                message = message + " | " + inner.Message;
                inner = inner.InnerException;
            }

            return ClassifyMessage(message, fallback);
        }

        private static bool ContainsAny(string haystack, string[] needles)
        {
            for (int i = 0; i < needles.Length; i++)
            {
                if (haystack.IndexOf(needles[i], StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
