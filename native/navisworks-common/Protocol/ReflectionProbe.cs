using System;
using System.Reflection;

namespace Matchline.Extraction.Protocol
{
    /// <summary>
    /// Reads a string-ish property by name, trying several spellings.
    /// <para>
    /// Used for the two pieces of descriptive Navisworks metadata whose member
    /// name is not the same across releases (the source-model GUID and the
    /// product version). Both are metadata, not control flow, so a wrong guess
    /// must degrade to "unknown" rather than fail to compile -- which is exactly
    /// what a compile-time member reference would do on a project that cannot be
    /// compiled against the real assembly here.
    /// </para>
    /// <para>
    /// Nothing in this type is Autodesk-specific; it takes the declaring
    /// <see cref="Type"/> from the caller. VERIFY-ON-WINDOWS: a reflective lookup
    /// is invisible to the compiler, so the stub build proves nothing about the
    /// names passed in.
    /// </para>
    /// </summary>
    public static class ReflectionProbe
    {
        /// <summary>
        /// Returns <c>ToString()</c> of the first candidate property that exists
        /// and yields a non-empty value, or null.
        /// </summary>
        /// <param name="declaringType">Type to look the property up on.</param>
        /// <param name="instance">Instance to read, or null for a static property.</param>
        /// <param name="candidateNames">Property names to try, in order.</param>
        /// <param name="rejectedValue">
        /// A value that counts as "not really set" (the empty GUID, say) and makes
        /// the probe try the next candidate. Null to accept anything non-empty.
        /// </param>
        public static string ReadString(
            Type declaringType, object instance, string[] candidateNames, string rejectedValue)
        {
            if (declaringType == null || candidateNames == null)
            {
                return null;
            }

            BindingFlags flags = instance == null
                ? BindingFlags.Public | BindingFlags.Static
                : BindingFlags.Public | BindingFlags.Instance;

            for (int i = 0; i < candidateNames.Length; i++)
            {
                try
                {
                    PropertyInfo property = declaringType.GetProperty(candidateNames[i], flags);
                    if (property == null || !property.CanRead)
                    {
                        continue;
                    }

                    object value = property.GetValue(instance, null);
                    if (value == null)
                    {
                        continue;
                    }

                    string text = value.ToString();
                    if (string.IsNullOrEmpty(text))
                    {
                        continue;
                    }

                    if (rejectedValue != null && string.Equals(text, rejectedValue, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    return text;
                }
                catch (Exception)
                {
                    // Ambiguous match, a throwing getter, a security failure: try
                    // the next candidate rather than losing the whole extraction
                    // over a descriptive field.
                }
            }

            return null;
        }
    }
}
