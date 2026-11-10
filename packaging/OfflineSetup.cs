using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class OfflineSetup
{
    [STAThread]
    private static int Main(string[] args)
    {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        bool quiet = args.Length == 2 && args[0] == "--quiet";
        try
        {
            if (args.Length != 0 && !quiet)
                throw new ArgumentException("Usage: Mindcraft-Setup.exe [--quiet <install-directory>]");
            string source = Assembly.GetExecutingAssembly().Location;
            string target = quiet ? args[1] : ChooseTarget();
            if (target == null) return 0;
            target = Path.GetFullPath(target);
            if (quiet) Install(source, target, null);
            else
            {
                using (var form = new Form())
                using (var bar = new ProgressBar())
                {
                    form.Text = "Installing Mindcraft";
                    form.ClientSize = new Size(440, 50);
                    form.ControlBox = false;
                    form.StartPosition = FormStartPosition.CenterScreen;
                    bar.Dock = DockStyle.Fill;
                    bar.Maximum = 1000;
                    form.Controls.Add(bar);
                    form.Show();
                    Install(source, target, (done, total) =>
                    {
                        bar.Value = (int)(1000L * done / total);
                        Application.DoEvents();
                    });
                }
            }
            if (!quiet)
            {
                CreateShortcut(target);
                MessageBox.Show("Mindcraft is installed. Open Mindcraft from the Start menu.", "Mindcraft Setup");
            }
            return 0;
        }
        catch (Exception error)
        {
            if (quiet) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "Mindcraft Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string ChooseTarget()
    {
        string parent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs");
        string target = Path.Combine(parent, "Mindcraft");
        var answer = MessageBox.Show("Install Mindcraft for this Windows user?\n\n" + target +
            "\n\nChoose No to select a different parent folder.", "Mindcraft Setup", MessageBoxButtons.YesNoCancel);
        if (answer == DialogResult.Cancel) return null;
        if (answer == DialogResult.Yes) return target;
        using (var picker = new FolderBrowserDialog())
        {
            picker.Description = "Select the parent folder for Mindcraft.";
            return picker.ShowDialog() == DialogResult.OK ? Path.Combine(picker.SelectedPath, "Mindcraft") : null;
        }
    }

    private static void Install(string source, string target, Action<long, long> report)
    {
        if (Directory.Exists(target) || File.Exists(target))
            throw new IOException("Choose an installation path that does not already exist: " + target);
        string parent = Path.GetDirectoryName(target);
        if (parent == null) throw new IOException("Choose an installation folder inside a drive.");
        Directory.CreateDirectory(parent);
        string staging = Path.Combine(parent, ".mc-" + Guid.NewGuid().ToString("N").Substring(0, 12));
        string prefix = staging + Path.DirectorySeparatorChar;
        using (var payload = File.OpenRead(source))
        using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
        {
            long bytes = 0;
            foreach (var entry in zip.Entries) bytes = checked(bytes + entry.Length);
            if (bytes == 0) throw new InvalidDataException("The installer payload is empty.");
            if (new DriveInfo(Path.GetPathRoot(target)).AvailableFreeSpace < bytes)
                throw new IOException("There is not enough disk space for Mindcraft.");
            Directory.CreateDirectory(staging);
            try
            {
                byte[] buffer = new byte[1024 * 1024];
                long written = 0, lastReport = 0;
                foreach (var entry in zip.Entries)
                {
                    string output = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                    if (!output.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || entry.FullName.Contains(":"))
                        throw new InvalidDataException("Invalid path in installer payload.");
                    Directory.CreateDirectory(Path.GetDirectoryName(output));
                    using (var input = entry.Open())
                    using (var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write))
                    {
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            file.Write(buffer, 0, count);
                            written += count;
                            if (report != null && (written == bytes || written - lastReport >= 32 * 1024 * 1024))
                            {
                                report(written, bytes);
                                lastReport = written;
                            }
                        }
                        if (file.Length != entry.Length) throw new InvalidDataException("Truncated file: " + entry.FullName);
                    }
                }
                Directory.Move(staging, target);
            }
            finally
            {
                if (Directory.Exists(staging)) DeleteWorkDirectory(staging);
            }
        }
    }

    private static void DeleteWorkDirectory(string directory)
    {
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            var attributes = File.GetAttributes(file);
            if ((attributes & FileAttributes.ReadOnly) != 0)
                File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
        }
        Directory.Delete(directory, true);
    }

    private static void CreateShortcut(string target)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Mindcraft.lnk");
        dynamic shortcut = shell.CreateShortcut(path);
        shortcut.TargetPath = Path.Combine(target, "Mindcraft.bat");
        shortcut.WorkingDirectory = target;
        shortcut.Save();
    }
}
