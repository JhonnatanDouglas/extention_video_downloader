using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class DslVideoDownloaderSetup
{
    private const string NativeHostName = "com.dsl.video_downloader";
    private const string ExtensionId = "ifgdnmefhdbeonkffcdmlgioongeckeb";
    private static bool Silent;

    [STAThread]
    public static int Main(string[] args)
    {
        Silent = args.Any(value => String.Equals(value, "--silent", StringComparison.OrdinalIgnoreCase));
        try
        {
            string installDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DSLVideoDownloader",
                "native-host");
            Directory.CreateDirectory(installDirectory);

            string hostPath = Path.Combine(installDirectory, "DslVideoDownloaderHost.exe");
            string manifestPath = Path.Combine(installDirectory, NativeHostName + ".json");
            ExtractHost(hostPath);
            RegisterNativeHost(hostPath, manifestPath);

            string ffmpeg = FindFfmpeg();
            if (String.IsNullOrEmpty(ffmpeg))
            {
                string installError = InstallFfmpeg();
                ffmpeg = FindFfmpeg();
                if (String.IsNullOrEmpty(ffmpeg))
                {
                    ShowMessage(
                        "O componente da extensao foi instalado, mas o FFmpeg nao foi encontrado.\n\n" + installError,
                        MessageBoxIcon.Warning);
                    return 2;
                }
            }

            ShowMessage(
                "Instalacao concluida.\n\nVolte ao Chrome, recarregue a extensao e abra o popup novamente.",
                MessageBoxIcon.Information);
            return 0;
        }
        catch (Exception error)
        {
            ShowMessage(
                "Nao foi possivel concluir a instalacao.\n\n" + error.Message,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void ShowMessage(string message, MessageBoxIcon icon)
    {
        if (Silent) return;
        MessageBox.Show(message, "DSL Video Downloader", MessageBoxButtons.OK, icon);
    }

    private static void ExtractHost(string destination)
    {
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("DslVideoDownloaderHost.exe"))
        {
            if (resource == null) throw new InvalidOperationException("O host nativo nao esta incorporado no instalador.");
            string temporary = destination + ".new";
            using (FileStream output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                resource.CopyTo(output);
            }
            if (File.Exists(destination)) File.Delete(destination);
            File.Move(temporary, destination);
        }
    }

    private static void RegisterNativeHost(string hostPath, string manifestPath)
    {
        string escapedPath = hostPath.Replace("\\", "\\\\").Replace("\"", "\\\"");
        string manifest = "{\n" +
            "  \"name\": \"" + NativeHostName + "\",\n" +
            "  \"description\": \"DSL Video Downloader native FFmpeg bridge\",\n" +
            "  \"path\": \"" + escapedPath + "\",\n" +
            "  \"type\": \"stdio\",\n" +
            "  \"allowed_origins\": [\"chrome-extension://" + ExtensionId + "/\"]\n" +
            "}\n";
        File.WriteAllText(manifestPath, manifest, new UTF8Encoding(false));

        Registry.SetValue(
            @"HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\" + NativeHostName,
            "",
            manifestPath,
            RegistryValueKind.String);
        Registry.SetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Edge\NativeMessagingHosts\" + NativeHostName,
            "",
            manifestPath,
            RegistryValueKind.String);
    }

    private static string InstallFfmpeg()
    {
        string winget = FindInPath("winget.exe");
        if (String.IsNullOrEmpty(winget))
        {
            try { Process.Start(new ProcessStartInfo { FileName = "ms-appinstaller:?source=https://aka.ms/getwinget", UseShellExecute = true }); }
            catch { }
            return "O WinGet nao esta instalado. Instale o App Installer da Microsoft e execute este instalador novamente.";
        }

        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = winget,
            Arguments = "install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements --silent",
            UseShellExecute = false,
            CreateNoWindow = false
        };
        using (Process process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode == 0 ? "" : "O WinGet terminou com o codigo " + process.ExitCode + ".";
        }
    }

    private static string FindFfmpeg()
    {
        string result = FindInPath("ffmpeg.exe");
        if (!String.IsNullOrEmpty(result)) return result;

        string links = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links", "ffmpeg.exe");
        if (File.Exists(links)) return links;
        string packages = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Packages");
        if (!Directory.Exists(packages)) return "";
        try
        {
            foreach (string directory in Directory.GetDirectories(packages, "Gyan.FFmpeg_*"))
            {
                string match = Directory.GetFiles(directory, "ffmpeg.exe", SearchOption.AllDirectories).FirstOrDefault();
                if (!String.IsNullOrEmpty(match)) return match;
            }
        }
        catch
        {
        }
        return "";
    }

    private static string FindInPath(string fileName)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in path.Split(Path.PathSeparator))
        {
            try
            {
                string candidate = Path.Combine(part.Trim().Trim('"'), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
            }
        }
        return "";
    }
}
