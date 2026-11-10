"""Build the Windows x64 offline installer from the already prepared local runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "mindcraft-agent-system"
RUNTIME = ROOT / "runtime"
PACKAGING = ROOT / "packaging"
NODE = "node-v22.23.3-win-x64"
MODEL = "Andy-4.2-Micro-Q4_K_M.gguf"
MODEL_SHA256 = "fa3f5e885e8d41d68d49394b490fe8d59c3448b23cbae176b3cdcb92a8d3cbb3"


def hash_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def add_tree(zip_file, root, target, exclude=()):
    skip_dirs = {".git", ".bin", "obj", "__pycache__"}
    skip_exts = {".log", ".err", ".tmp", ".pdb", ".obj", ".ilk"}
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(name for name in subdirs if name not in skip_dirs)
        for name in sorted(files):
            source = Path(directory) / name
            if source.relative_to(root).as_posix() in exclude or name == ".package-lock.json" or source.suffix.lower() in skip_exts:
                continue
            if source.is_symlink():
                raise ValueError(f"Unexpected symbolic link: {source}")
            zip_file.write(source, target / source.relative_to(root))


def build_payload(output, vc_runtime):
    model = ROOT / "models" / MODEL
    if hash_file(model) != MODEL_SHA256:
        raise ValueError(f"Unexpected model checksum: {MODEL}")

    # Append the ZIP to the PE. ZIP offsets are relative to the whole EXE.
    with ZipFile(output, "a", compression=ZIP_DEFLATED, compresslevel=1) as payload:
        app = Path("mindcraft-agent-system")
        for name in ("main.js", "package.json", "andy-reference.json", "LICENSE"):
            payload.write(APP / name, app / name)
        settings = (APP / "settings.js").read_text(encoding="utf-8")
        if '"port": 25565' not in settings:
            raise ValueError("Review the shipped Minecraft connection defaults.")
        payload.writestr((app / "settings.js").as_posix(), settings)

        spec = json.loads((APP / "src/mindcraft/public/settings_spec.json").read_text(encoding="utf-8"))
        spec["port"]["default"] = 25565
        payload.writestr((app / "src/mindcraft/public/settings_spec.json").as_posix(), json.dumps(spec, ensure_ascii=False, indent=4))
        add_tree(payload, APP / "src", app / "src", exclude=("mindcraft/public/settings_spec.json",))
        for name in ("profiles/defaults", "node_modules"):
            add_tree(payload, APP / name, app / name)
        for name in ("execTemplate.js", "lintTemplate.js"):
            payload.write(APP / "bots" / name, app / "bots" / name)

        payload.write(PACKAGING / "Mindcraft.bat", "Mindcraft.bat")
        payload.write(PACKAGING / "README.txt", "README.txt")
        payload.write(PACKAGING / "Andy-4.2-LICENSE.txt", "licenses/Andy-4.2-LICENSE.txt")
        payload.write(ROOT / "start-mindcraft.ps1", "start-mindcraft.ps1")
        for name in ("andy-model-selection.ps1", "live-log.cjs"):
            payload.write(RUNTIME / name, f"runtime/{name}")
        for name in ("node.exe", "LICENSE"):
            payload.write(RUNTIME / NODE / name, f"runtime/{NODE}/{name}")
        for folder in ("llama/bin", "llama-rocm"):
            source = RUNTIME / folder
            for binary in sorted(source.iterdir()):
                if binary.name in {"llama-server.exe", "llama-bench.exe"} or binary.suffix.lower() == ".dll" or binary.name.startswith("LICENSE"):
                    payload.write(binary, f"runtime/{folder}/{binary.name}")
            if folder == "llama-rocm":
                for name in (".kpack", "hipblaslt", "rocblas"):
                    add_tree(payload, source / name, Path(f"runtime/{folder}/{name}"))
        for dll in sorted(vc_runtime.glob("*.dll")):
            for folder in (NODE, "llama/bin", "llama-rocm"):
                payload.write(dll, f"runtime/{folder}/{dll.name}")
        payload.write(model, f"models/{MODEL}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vc-runtime", type=Path, required=True)
    args = parser.parse_args()
    if not (args.vc_runtime / "vcruntime140.dll").is_file():
        parser.error("--vc-runtime must point to the Visual C++ x64 app-local redistributable DLLs.")

    output = ROOT / "dist" / "Mindcraft-Micro-Q4-Setup.exe"
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(".building.exe")
    csc = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    try:
        subprocess.run([
            str(csc), "/nologo", "/platform:x64", "/target:winexe", "/optimize+",
            "/r:System.IO.Compression.dll", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll",
            "/r:Microsoft.CSharp.dll", f"/out:{temp}", "OfflineSetup.cs",
        ], cwd=PACKAGING, check=True)
        build_payload(temp, args.vc_runtime)
        if temp.stat().st_size >= 2**31:
            raise ValueError("Installer exceeds the 2 GiB single-EXE build limit.")
        temp.replace(output)
    finally:
        temp.unlink(missing_ok=True)
    print(f"{output.name}: {output.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
