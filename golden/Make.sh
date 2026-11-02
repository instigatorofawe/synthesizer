#!/bin/sh
# Writes the golden images and their renders, once each. They are the format's contract, so this never touches one that exists:
# a change to any of them is a change to what old images mean. A later revision adds its own project and a new line below.
# Expects native tools in build/tools.
set -e
cd "$(dirname "$0")/.."

make_golden() { # name frames
    if [ -e "golden/$1.image" ]; then
        return
    fi
    build/tools/modsynth_compile "golden/$1.json" "golden/$1.image"
    build/tools/modsynth_render "golden/$1.image" "golden/$1.stereo.f32" "$2" 2
    build/tools/modsynth_render "golden/$1.image" "golden/$1.mono.f32" "$2" 1
}

make_golden Minimal 8
make_golden Demo 480
make_golden AllOps 400
make_golden Waves 200
make_golden Tones 200

# Revision 3. Frames here are the image's own, so these are as long as the four above.
make_golden Demo32 1920
make_golden AllOps32 1600
make_golden Waves32 800
make_golden Tones32 800

# Revision 4. A new project at the default frame size has no second form, so these keep plain names.
make_golden Lanes 1920
make_golden Zones 1920

# Revision 5.
make_golden Hold 1920

# Revision 6.
make_golden Mods 1920

# What a device receives when it already has every chunk but the Programs.
if [ -e golden/Demo.thin.image ]; then
    exit 0
fi
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
