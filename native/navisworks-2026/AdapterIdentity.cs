namespace Matchline.Extraction.NavisworksAdapter
{
    /// <summary>
    /// The only thing that differs between the year adapters.
    /// <para>
    /// Every other source file in this assembly is compiled from
    /// native/navisworks-adapter, shared verbatim with the other years. This
    /// constant is what makes the shared code stamp the right
    /// <c>meta.adapter_version</c>, and it is the file to look at first if a
    /// cache claims the wrong version.
    /// </para>
    /// </summary>
    internal static class AdapterIdentity
    {
        internal const int Year = 2026;
    }
}
