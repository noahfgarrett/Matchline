using System;
using System.Globalization;
using Autodesk.Navisworks.Api;

namespace Matchline.Extraction.NavisworksAdapter
{
    /// <summary>
    /// Turns a Navisworks <see cref="VariantData"/> into the pair the cache
    /// stores: a type name and a canonical, culture-invariant string.
    /// <para>
    /// Dispatch is on <c>DataType.ToString()</c> rather than on enum members, so
    /// a VariantDataType that this build has never heard of falls through to the
    /// default arm instead of failing to compile or throwing. That is also what
    /// lets one file serve 2024, 2025 and 2026: a year that adds a variant type
    /// degrades to its ToString() instead of needing a new adapter.
    /// </para>
    /// <para>
    /// VERIFY-ON-WINDOWS. Two halves, with very different standing:
    /// </para>
    /// <para>
    /// (a) The eleven accessors are shape-pinned by the stub build, including
    /// their return types, because this code consumes each one: ToDisplayString
    /// and ToIdentifierString return string; ToInt32 returns int; ToDouble,
    /// ToDoubleLength, ToDoubleAngle, ToDoubleArea and ToDoubleVolume return
    /// double; ToBoolean returns bool; ToDateTime returns DateTime;
    /// ToNamedConstant returns a reference type with a string DisplayName. Names
    /// and arities are still guesses, just internally consistent ones, and each
    /// is a separate case so a wrong guess is a one-line fix.
    /// </para>
    /// <para>
    /// (b) FULLY OPEN: the spelling of the VariantDataType names in the case
    /// labels. They are compared as strings, so the compiler never sees them and
    /// the stub cannot pin them. A mismatch shows up at runtime as values landing
    /// in the default arm with a type name that no case handles.
    /// </para>
    /// </summary>
    internal static class VariantFormatter
    {
        internal const string NoneTypeName = "None";

        internal static void Format(VariantData value, out string typeName, out string text)
        {
            if (value == null)
            {
                typeName = NoneTypeName;
                text = null;
                return;
            }

            try
            {
                typeName = value.DataType.ToString();
            }
            catch (Exception)
            {
                typeName = NoneTypeName;
                text = null;
                return;
            }

            try
            {
                text = FormatValue(value, typeName);
            }
            catch (Exception)
            {
                // A value that will not convert is recorded as null rather than
                // aborting the item; the type name still tells the reading side
                // what was there.
                text = null;
            }
        }

        private static string FormatValue(VariantData value, string typeName)
        {
            switch (typeName)
            {
                case "None":
                    return null;

                case "DisplayString":
                    return value.ToDisplayString();

                case "IdentifierString":
                    return value.ToIdentifierString();

                case "Int32":
                    return value.ToInt32().ToString(CultureInfo.InvariantCulture);

                case "Double":
                    return FormatDouble(value.ToDouble());

                case "DoubleLength":
                    return FormatDouble(value.ToDoubleLength());

                case "DoubleAngle":
                    return FormatDouble(value.ToDoubleAngle());

                case "DoubleArea":
                    return FormatDouble(value.ToDoubleArea());

                case "DoubleVolume":
                    return FormatDouble(value.ToDoubleVolume());

                case "Boolean":
                    return value.ToBoolean() ? "true" : "false";

                case "DateTime":
                    return value.ToDateTime().ToUniversalTime()
                        .ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

                case "NamedConstant":
                    NamedConstant constant = value.ToNamedConstant();
                    if (constant == null)
                    {
                        return null;
                    }

                    string display = constant.DisplayName;
                    return string.IsNullOrEmpty(display) ? constant.ToString() : display;

                default:
                    // Point3D, Point2D and anything added in a later release.
                    // ToString() is lossy but stable, and the type name records
                    // that a richer form exists.
                    return value.ToString();
            }
        }

        private static string FormatDouble(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                return null;
            }

            return value.ToString("R", CultureInfo.InvariantCulture);
        }
    }
}
