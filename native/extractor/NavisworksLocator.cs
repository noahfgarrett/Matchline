using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>A located Navisworks install.</summary>
    internal sealed class NavisworksInstall
    {
        internal NavisworksInstall(string installDirectory, string executablePath, string product, int year)
        {
            InstallDirectory = installDirectory;
            ExecutablePath = executablePath;
            Product = product;
            Year = year;
        }

        internal string InstallDirectory { get; private set; }

        /// <summary>Full path to Roamer.exe.</summary>
        internal string ExecutablePath { get; private set; }

        /// <summary>"Manage" or "Simulate", or "Unknown" for an explicit override.</summary>
        internal string Product { get; private set; }

        /// <summary>Release year, or <see cref="NavisworksLocator.UnknownYear"/>.</summary>
        internal int Year { get; private set; }

        /// <summary>
        /// What Matchline can honestly claim about this year, or null when there
        /// is no adapter for it. Single source of truth: SupportedAdapters.
        /// </summary>
        internal AdapterSupport Adapter
        {
            get { return SupportedAdapters.ForYear(Year); }
        }

        internal bool IsSupported
        {
            get { return Adapter != null; }
        }

        internal string Describe()
        {
            string year = Year == NavisworksLocator.UnknownYear
                ? "(unknown year)"
                : Year.ToString(CultureInfo.InvariantCulture);

            return "Navisworks " + Product + " " + year + " (" + InstallDirectory + ")";
        }
    }

    /// <summary>
    /// Finds every installed Navisworks, and picks the one that will open the
    /// file.
    /// <para>
    /// Policy (DECISIONS.md): an NWD has no forward compatibility, so the newest
    /// installed version wins, and Manage is preferred over Simulate at the same
    /// year. Freedom is never a candidate -- it has no API.
    /// </para>
    /// <para>
    /// Years outside <see cref="SupportedAdapters"/> are probed too, and
    /// deliberately so: finding a Navisworks Matchline has no adapter for is a
    /// different failure from finding none at all, and the error can only say
    /// which it is if the probe looked.
    /// </para>
    /// <para>
    /// Phase 1 probes the default install locations rather than the registry.
    /// A non-default install is handled by --navisworks-dir. VERIFY-ON-WINDOWS:
    /// confirm the default path shape on the proof machine; if Navisworks is
    /// installed somewhere else, note the real path so a registry lookup can be
    /// added deliberately rather than guessed at.
    /// </para>
    /// </summary>
    internal static class NavisworksLocator
    {
        internal const string ExecutableName = "Roamer.exe";

        /// <summary>Year of an install whose folder name does not carry one.</summary>
        internal const int UnknownYear = 0;

        /// <summary>
        /// Probe range, newest first. It reaches past the supported years on both
        /// sides on purpose: a 2023 or a 2029 install must be reported as "found,
        /// no adapter", never as "nothing installed".
        /// </summary>
        private const int NewestProbedYear = 2029;

        private const int OldestProbedYear = 2021;

        /// <summary>Manage first: same year, richer product, same API surface.</summary>
        private static readonly string[] Products = { "Manage", "Simulate" };

        /// <summary>
        /// Validates an explicit install directory. Returns null when Roamer.exe
        /// is not there.
        /// </summary>
        internal static NavisworksInstall FromDirectory(string directory)
        {
            if (string.IsNullOrEmpty(directory))
            {
                return null;
            }

            string executable = Path.Combine(directory, ExecutableName);
            if (!File.Exists(executable))
            {
                return null;
            }

            int year = GuessYear(directory);
            string product = directory.IndexOf("Simulate", StringComparison.OrdinalIgnoreCase) >= 0
                ? "Simulate"
                : (directory.IndexOf("Manage", StringComparison.OrdinalIgnoreCase) >= 0 ? "Manage" : "Unknown");

            return new NavisworksInstall(directory, executable, product, year);
        }

        /// <summary>
        /// Every Navisworks found in a default location, best candidate first:
        /// newest year, and Manage before Simulate within a year. Never null.
        /// </summary>
        internal static List<NavisworksInstall> FindAll()
        {
            List<NavisworksInstall> found = new List<NavisworksInstall>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> roots = ProgramFilesRoots();

            // Year is the outermost loop, so the newest install wins regardless
            // of which Program Files root it happens to live under.
            for (int year = NewestProbedYear; year >= OldestProbedYear; year--)
            {
                for (int p = 0; p < Products.Length; p++)
                {
                    for (int r = 0; r < roots.Count; r++)
                    {
                        string directory = Path.Combine(
                            roots[r],
                            "Autodesk",
                            "Navisworks " + Products[p] + " " + year.ToString(CultureInfo.InvariantCulture));

                        string executable = Path.Combine(directory, ExecutableName);
                        if (File.Exists(executable) && seen.Add(directory))
                        {
                            found.Add(new NavisworksInstall(directory, executable, Products[p], year));
                        }
                    }
                }
            }

            return found;
        }

        /// <summary>
        /// The install that will open the file: newest year Matchline has an
        /// adapter for. Null when none of the installs qualifies.
        /// </summary>
        internal static NavisworksInstall SelectNewestSupported(IList<NavisworksInstall> installs)
        {
            if (installs == null)
            {
                return null;
            }

            for (int i = 0; i < installs.Count; i++)
            {
                if (installs[i].IsSupported)
                {
                    return installs[i];
                }
            }

            return null;
        }

        /// <summary>The best install for one specific year, or null when it is not installed.</summary>
        internal static NavisworksInstall SelectYear(IList<NavisworksInstall> installs, int year)
        {
            if (installs == null)
            {
                return null;
            }

            for (int i = 0; i < installs.Count; i++)
            {
                if (installs[i].Year == year)
                {
                    return installs[i];
                }
            }

            return null;
        }

        /// <summary>Human-readable list for an error message. "" when nothing was found.</summary>
        internal static string DescribeAll(IList<NavisworksInstall> installs)
        {
            if (installs == null || installs.Count == 0)
            {
                return string.Empty;
            }

            string text = string.Empty;
            for (int i = 0; i < installs.Count; i++)
            {
                if (text.Length > 0)
                {
                    text += "; ";
                }

                text += installs[i].Describe();
            }

            return text;
        }

        private static List<string> ProgramFilesRoots()
        {
            List<string> roots = new List<string>(2);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!string.IsNullOrEmpty(programFiles))
            {
                roots.Add(programFiles);
            }

            // A 32-bit host process reports the x86 folder for ProgramFiles; the
            // environment variable is the reliable way to reach the 64-bit one.
            string programW6432 = Environment.GetEnvironmentVariable("ProgramW6432");
            if (!string.IsNullOrEmpty(programW6432) && !roots.Contains(programW6432))
            {
                roots.Add(programW6432);
            }

            return roots;
        }

        private static int GuessYear(string directory)
        {
            string name = new DirectoryInfo(directory.TrimEnd(Path.DirectorySeparatorChar)).Name;
            for (int i = 0; i + 4 <= name.Length; i++)
            {
                int year;
                if (int.TryParse(name.Substring(i, 4), NumberStyles.None, CultureInfo.InvariantCulture, out year) &&
                    year >= 2000 && year <= 2100)
                {
                    return year;
                }
            }

            return UnknownYear;
        }
    }
}
