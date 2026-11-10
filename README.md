# Mindcraft Optimized Pack

A Windows x64 distribution of Mindcraft CE with a browser dashboard, agent cards, and local inference powered by Andy 4.2 Micro Q4.

## Install and run

1. Download `Mindcraft-Micro-Q4-Setup.exe` (2.14 GB) from [Release 0.1](https://github.com/asd123718/mindcraft-optimized-pack/releases/tag/0.1).
2. Double-click the EXE to install. Launch Mindcraft from the Start menu or double-click `Mindcraft.bat` in the installation folder. The installer is unsigned.
3. Open the dashboard at `http://127.0.0.1:8080`. On first launch, it shows one idle Andy agent. Open your Minecraft world to LAN, enter its port in the agent card settings, and start the agent.

The installer includes Node.js, runtime dependencies, llama.cpp, and the Micro Q4 weights. Installation and local inference work offline. CUDA and ROCm acceleration require a compatible Windows graphics driver. Minecraft is installed separately.

## Run from source or build the installer

This repository includes the framework source, dependency lockfile and patches, and installer source. Double-clicking `Mindcraft.bat` in the source checkout opens the release download page or runs the installer if you have already placed it in the same folder.

To run the framework from source, install Node.js 22, open the `mindcraft-agent-system` directory, run `npm ci` to install and patch the dependencies, then run `npm start`. The agent profile must point to a compatible model server.

To build the offline EXE, follow the paths in `packaging/build.py` when placing the Windows x64 Node.js runtime, llama.cpp CUDA and ROCm runtimes, Visual C++ x64 app-local DLLs, and the [official Micro Q4 weights](https://huggingface.co/Mindcraft-CE/Andy-4.2-Micro-GGUF). Save the model as `models/Andy-4.2-Micro-Q4_K_M.gguf`. The builder verifies its SHA-256 hash. With Python 3.11 or later, run:

```powershell
python packaging/build.py --vc-runtime "<path to the Visual C++ DLLs>"
```

## License

The source follows the [MIT license](LICENSE) of [Mindcraft CE](https://github.com/mindcraft-ce/mindcraft-ce). Andy model weights are covered by the separate [Andy 2.0 License](licenses/Andy-4.2-LICENSE.txt). Third-party components in the installer retain their respective licenses.

This work uses data and models created by @Sweaterdog, and the Mindcraft Project.
