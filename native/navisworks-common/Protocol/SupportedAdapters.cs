using System;
using System.Globalization;

namespace Matchline.Extraction.Protocol
{
    /// <summary>
    /// How far a version adapter has actually been proven. These are the only
    /// three states, and the difference between them is what the launcher is
    /// allowed to claim about a version.
    /// </summary>
    public static class AdapterVerification
    {
        /// <summary>
        /// The adapter compiles only against native/navisworks-stubs, a
        /// hand-written stand-in whose signatures were derived from our own code
        /// rather than from Autodesk. Nothing about it has been run against the
        /// real API. This is NOT support; it is a compile check.
        /// </summary>
        public const string StubCompiledOnly = "stub-compiled-unverified";

        /// <summary>
        /// The adapter compiles against the real Autodesk assembly, but the
        /// Windows proof run (docs/WINDOWS-RUNBOOK.md) has not been completed and
        /// signed off yet.
        /// </summary>
        public const string RealProofPending = "pending-real-proof";

        /// <summary>
        /// The adapter has extracted a real model on a real install and the run
        /// was recorded. Only a version in this state may be advertised as
        /// supported (docs/RELEASE-1.0-PLAN.md: never advertise unverified
        /// versions). Nothing is in this state yet; flipping a year to it is a
        /// deliberate act taken with proof in hand.
        /// </summary>
        public const string Verified = "verified";
    }

    /// <summary>One Navisworks year and what Matchline can honestly say about it.</summary>
    public sealed class AdapterSupport
    {
        private readonly int _year;
        private readonly string _verificationStatus;

        internal AdapterSupport(int year, string verificationStatus)
        {
            _year = year;
            _verificationStatus = verificationStatus;
        }

        public int Year
        {
            get { return _year; }
        }

        /// <summary>Value stamped into <c>meta.adapter_version</c>, e.g. "navisworks-2025".</summary>
        public string AdapterVersion
        {
            get { return SupportedAdapters.AdapterVersionForYear(_year); }
        }

        /// <summary>One of <see cref="AdapterVerification"/>.</summary>
        public string VerificationStatus
        {
            get { return _verificationStatus; }
        }

        /// <summary>True only for a year that has passed a real run on a real install.</summary>
        public bool IsVerified
        {
            get { return string.Equals(_verificationStatus, AdapterVerification.Verified, StringComparison.Ordinal); }
        }

        /// <summary>e.g. "2025 (adapter navisworks-2025, pending-real-proof)".</summary>
        public string Describe()
        {
            return _year.ToString(CultureInfo.InvariantCulture) +
                " (adapter " + AdapterVersion + ", " + _verificationStatus + ")";
        }
    }

    /// <summary>
    /// The single source of truth for which Navisworks years Matchline ships an
    /// adapter for, and how far each one has been proven.
    /// <para>
    /// Everything that tells a human what is supported -- the launcher's detect
    /// message, its "no usable Navisworks" errors, docs/EXTRACTION.md -- reads
    /// this table. Adding a year here without adding
    /// native/navisworks-&lt;year&gt; is a lie the compiler cannot catch, so the
    /// two go together.
    /// </para>
    /// </summary>
    public static class SupportedAdapters
    {
        /// <summary>Newest first. Order is load-bearing: selection takes the first match.</summary>
        private static readonly AdapterSupport[] Table =
        {
            new AdapterSupport(2026, AdapterVerification.StubCompiledOnly),
            new AdapterSupport(2025, AdapterVerification.RealProofPending),
            new AdapterSupport(2024, AdapterVerification.StubCompiledOnly)
        };

        /// <summary>Every supported year, newest first. Returns a fresh array.</summary>
        public static AdapterSupport[] All()
        {
            AdapterSupport[] copy = new AdapterSupport[Table.Length];
            Array.Copy(Table, copy, Table.Length);
            return copy;
        }

        /// <summary>The entry for a year, or null when Matchline has no adapter for it.</summary>
        public static AdapterSupport ForYear(int year)
        {
            for (int i = 0; i < Table.Length; i++)
            {
                if (Table[i].Year == year)
                {
                    return Table[i];
                }
            }

            return null;
        }

        public static bool IsSupported(int year)
        {
            return ForYear(year) != null;
        }

        /// <summary>
        /// The <c>meta.adapter_version</c> spelling for a year. Defined for any
        /// year, not just supported ones: the adapter stamps its own identity and
        /// must never write an empty required meta value.
        /// </summary>
        public static string AdapterVersionForYear(int year)
        {
            return "navisworks-" + year.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// The adapter assembly's name for a year, e.g.
        /// "Matchline.Extraction.Navisworks2025".
        /// <para>
        /// It is also the name of the folder the DLL must sit in, because
        /// Navisworks insists the plugin folder name matches the assembly name
        /// (native/navisworks-adapter/Matchline.Navisworks.Adapter.props, which
        /// derives the same string from MatchlineNavisworksYear). The launcher's
        /// pre-flight check builds the expected path from this, so the build and
        /// the check cannot spell it differently.
        /// </para>
        /// </summary>
        public static string PluginAssemblyNameForYear(int year)
        {
            return "Matchline.Extraction.Navisworks" + year.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>Supported years for a message, oldest first: "2024, 2025, 2026".</summary>
        public static string YearList()
        {
            string text = string.Empty;
            for (int i = Table.Length - 1; i >= 0; i--)
            {
                if (text.Length > 0)
                {
                    text += ", ";
                }

                text += Table[i].Year.ToString(CultureInfo.InvariantCulture);
            }

            return text;
        }
    }
}
