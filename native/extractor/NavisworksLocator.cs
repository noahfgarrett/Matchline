using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

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

        internal int Year { get; private set; }

        internal string Describe()
        {
            return Product + " " + Year.ToString(CultureInfo.InvariantCulture) + " (" + InstallDirectory + ")";
        }
    }

    /// <summary>
    /// Finds an installed Navisworks.
    /// <para>
    /// Policy (DECISIONS.md): newest installed version wins, and Manage is
    /// preferred over Simulate at the same year. Freedom is never a candidate --
    /// it has no API.
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

        /// <summary>Years this launcher will consider, newest first.</summary>
        private static readonly int[] SupportedYears = { 2026, 2025, 2024, 2023, 2022, 2021 };

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

        /// <summary>Newest installed Navisworks, or null when none is found.</summary>
        internal static NavisworksInstall FindNewest()
        {
            foreach (string root in ProgramFilesRoots())
            {
                for (int y = 0; y < SupportedYears.Length; y++)
                {
                    for (int p = 0; p < Products.Length; p++)
                    {
                        string directory = Path.Combine(
                            root,
                            "Autodesk",
                            "Navisworks " + Products[p] + " " + SupportedYears[y].ToString(CultureInfo.InvariantCulture));

                        string executable = Path.Combine(directory, ExecutableName);
                        if (File.Exists(executable))
                        {
                            return new NavisworksInstall(directory, executable, Products[p], SupportedYears[y]);
                        }
                    }
                }
            }

            return null;
        }

        private static IEnumerable<string> ProgramFilesRoots()
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

            return 0;
        }
    }
}
