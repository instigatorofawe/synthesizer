#!/bin/sh
# Writes the golden images and their renders, once. They are the format's contract, so this refuses to overwrite one: a change
# to any of them is a change to what old images mean. A later revision adds its own project here and a new line below.
# Expects native tools in build/tools.
set -e
cd "$(dirname "$0")/.."

make_golden() { # name frames
    if [ -e "golden/$1.image" ]; then
        echo "golden/$1.image exists, and golden images never change" >&2
        exit 1
    fi
    build/tools/modsynth_compile "golden/$1.json" "golden/$1.image"
    build/tools/modsynth_render "golden/$1.image" "golden/$1.stereo.f32" "$2" 2
    build/tools/modsynth_render "golden/$1.image" "golden/$1.mono.f32" "$2" 1
}

make_golden Minimal 8
make_golden Demo 480
make_golden AllOps 400

# What a device receives when it already has every chunk but the Programs.
python3 - <<'PYTHON'
import json
import subprocess

report = "build/tools/Thin.report.json"
subprocess.run(["build/tools/modsynth_compile", "golden/Demo.json", "build/tools/Thin.image", report], check=True)
request = json.load(open("golden/Demo.json"))
request["omit"] = [c["hash"] for c in json.load(open(report))["chunks"] if c["kind"] != "program"]
json.dump(request, open("build/tools/Thin.json", "w"))
subprocess.run(["build/tools/modsynth_compile", "build/tools/Thin.json", "golden/Demo.thin.image"], check=True)
PYTHON
