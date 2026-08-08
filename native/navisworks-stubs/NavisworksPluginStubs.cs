// =============================== NOT SHIPPED ===============================
// Compile-only stand-in for Autodesk.Navisworks.Api.Plugins. See
// NavisworksApiStubs.cs for the rules this file follows.
//
// The attribute types are the exception to "every member throws": attribute
// arguments and named properties are written into the assembly's metadata blob
// by the compiler, so a throwing setter would be pure noise -- it can never
// run during a build. They are declared with ordinary auto-properties.
// ===========================================================================

using System;

namespace Autodesk.Navisworks.Api.Plugins
{
    /// <summary>
    /// Stub. Identity attribute every Navisworks plugin carries.
    /// <para>
    /// Assumed: <c>(string name, string developerId)</c> positional, with
    /// <c>DisplayName</c> and <c>ToolTip</c> as named properties, and the
    /// command-line id formed as <c>name.developerId</c>. The id format is a
    /// runtime convention, not a compile-time one -- the stub cannot check it.
    /// </para>
    /// </summary>
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
    public sealed class PluginAttribute : Attribute
    {
        public PluginAttribute(string name, string developerId)
        {
            Name = name;
            DeveloperId = developerId;
        }

        public string Name { get; private set; }

        public string DeveloperId { get; private set; }

        public string DisplayName { get; set; }

        public string ToolTip { get; set; }
    }

    /// <summary>
    /// Stub. Marks the plugin as an add-in and says where it surfaces.
    /// Assumed: a single positional <see cref="AddInLocation"/>.
    /// </summary>
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
    public sealed class AddInPluginAttribute : Attribute
    {
        public AddInPluginAttribute(AddInLocation location)
        {
            Location = location;
        }

        public AddInLocation Location { get; private set; }
    }

    /// <summary>
    /// Stub. Only <see cref="AddIn"/> is declared, because it is the only member
    /// the plugin names. Whether the real enum also has a "None" that would keep
    /// this headless plugin out of the ribbon is an open question the stub
    /// cannot answer -- adding a speculative member here would fake an answer.
    /// </summary>
    public enum AddInLocation
    {
        AddIn = 0,
    }

    /// <summary>
    /// Stub. Base class for add-in plugins.
    /// Assumed: <c>public abstract int Execute(params string[] parameters)</c>.
    /// </summary>
    public abstract class AddInPlugin
    {
        public abstract int Execute(params string[] parameters);
    }
}
