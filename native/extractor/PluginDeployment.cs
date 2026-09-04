using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// Where the extraction plugin has to be for Navisworks to find it, and
    /// whether it is actually there.
    /// <para>
    /// Checked before Roamer is started, because the failure it prevents is the
    /// worst-shaped one in the whole launcher: Navisworks opens, discovers no
    /// plugin, may or may not put a message box on an invisible desktop, and
    /// either exits with no stream (which used to be reported as a generic
    /// "the model walk did not finish, add the file again") or sits there
    /// forever. None of that is about the model, and re-adding the file cannot
    /// possibly help. A pre-flight turns it into one sentence naming the folder
    /// the DLL is missing from.
    /// </para>
    /// <para>
    /// Two roots are accepted, because which one Navisworks scans is one of the
    /// things the first Windows proof run settles (docs/WINDOWS-RUNBOOK.md §4):
    /// the install directory's own <c>Plugins</c> folder, and the per-user
    /// <c>%APPDATA%\Autodesk Navisworks &lt;Product&gt; &lt;year&gt;\Plugins</c>
    /// root that needs no administrator to write to. Finding the DLL under
    /// either is enough to proceed; the run itself proves which one loaded.
    /// </para>
    /// </summary>
    internal static class PluginDeployment
    {
        /// <summary>The folder name Navisworks insists on: the assembly's own name.</summary>
        internal const string PluginsFolderName = "Plugins";

        /// <summary>
        /// True when the adapter DLL is under one of the Plugins roots for this
        /// install, or when the check cannot be made at all.
        /// <para>
        /// "Cannot be made" is deliberately a pass, not a failure: an install
        /// reached through --navisworks-dir whose folder name carries no year
        /// has no assembly name to look for, and refusing to run because the
        /// launcher could not construct a path would break the one escape hatch
        /// a non-standard install has.
        /// </para>
        /// </summary>
        /// <param name="install">The install that will open the file.</param>
        /// <param name="foundPath">The DLL that was found, or null.</param>
        /// <param name="searched">Every folder that was looked in, for the error message.</param>
        internal static bool IsDeployed(
            NavisworksInstall install, out string foundPath, out string searched)
        {
            foundPath = null;
            searched = string.Empty;

            if (install == null || install.Year == NavisworksLocator.UnknownYear)
            {
                return true;
            }

            string assemblyName = SupportedAdapters.PluginAssemblyNameForYear(install.Year);
            List<string> candidates = CandidateFolders(install, assemblyName);
            if (candidates.Count == 0)
            {
                return true;
            }

            List<string> looked = new List<string>(candidates.Count);
            for (int i = 0; i < candidates.Count; i++)
            {
                string dll = Path.Combine(candidates[i], assemblyName + ".dll");
                looked.Add(dll);
                if (SafeFileExists(dll))
                {
                    foundPath = dll;
                    return true;
                }
            }

            searched = string.Join(" or ", looked.ToArray());
            return false;
        }

        /// <summary>
        /// The sentence a missing plugin gets. It names both folders verbatim,
        /// because copying one of them is the entire fix.
        /// </summary>
        internal static string DescribeMissing(NavisworksInstall install, string searched)
        {
            return "The Matchline extraction add-in is not installed for " + install.Describe() +
                ". Navisworks loads plugins only from a folder named after the assembly, so " +
                "Matchline.Extraction.Common.dll and the adapter DLL must sit in one of: " +
                searched + ".";
        }

        private static List<string> CandidateFolders(NavisworksInstall install, string assemblyName)
        {
            List<string> folders = new List<string>(2);

            if (!string.IsNullOrEmpty(install.InstallDirectory))
            {
                folders.Add(Combine(install.InstallDirectory, PluginsFolderName, assemblyName));
            }

            // The per-user root, which is the one a non-administrator installer
            // can write to. Its folder is named for the product and year the way
            // Autodesk writes it, e.g. "Autodesk Navisworks Manage 2025".
            string roaming = SafeFolderPath(Environment.SpecialFolder.ApplicationData);
            if (!string.IsNullOrEmpty(roaming) && !string.IsNullOrEmpty(install.Product))
            {
                string productFolder = "Autodesk Navisworks " + install.Product + " " +
                    install.Year.ToString(CultureInfo.InvariantCulture);
                folders.Add(Combine(roaming, productFolder, PluginsFolderName, assemblyName));
            }

            folders.RemoveAll(IsBlank);
            return folders;
        }

        private static bool IsBlank(string value)
        {
            return string.IsNullOrEmpty(value);
        }

        /// <summary>
        /// Path.Combine that answers null instead of throwing. A malformed
        /// install path is a candidate that cannot be checked, not a crash.
        /// </summary>
        private static string Combine(params string[] parts)
        {
            try
            {
                string combined = parts[0];
                for (int i = 1; i < parts.Length; i++)
                {
                    combined = Path.Combine(combined, parts[i]);
                }

                return combined;
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        private static string SafeFolderPath(Environment.SpecialFolder folder)
        {
            try
            {
                return Environment.GetFolderPath(folder);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static bool SafeFileExists(string path)
        {
            try
            {
                return File.Exists(path);
            }
            catch (Exception)
            {
                // File.Exists swallows almost everything already; this covers
                // the paths it does not, so a pre-flight can never be the thing
                // that fails a run.
                return false;
            }
        }
    }
}
