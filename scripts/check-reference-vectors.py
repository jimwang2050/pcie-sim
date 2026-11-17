"""Compare hand-written header DWORD fixtures against a local cocotbext-pcie.

Usage: python3 scripts/check-reference-vectors.py ../cocotbext-pcie-master
Loads only pure codec modules, without installing cocotb or copying upstream code.
"""
import importlib.util
import json
from pathlib import Path
import sys
import types
import hashlib

sys.dont_write_bytecode = True

root = Path(sys.argv[1]).resolve()
codec = root / "cocotbext/pcie/core"
package = types.ModuleType("reference_codec")
package.__path__ = [str(codec)]
sys.modules[package.__name__] = package
for name in ["dllp", "utils", "tlp"]:
    spec = importlib.util.spec_from_file_location(f"reference_codec.{name}", codec / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
tlp = sys.modules["reference_codec.tlp"]
PcieId = sys.modules["reference_codec.utils"].PcieId
fixtures = json.loads((Path(__file__).resolve().parent.parent / "tests/fixtures/nfm-headers.json").read_text())
results = []
for v in fixtures["vectors"]:
    i = v["input"]
    p = tlp.Tlp()
    p.requester_id = PcieId.from_int(i["requester"])
    p.tag = i["tag"]
    if v["builder"] == "cfg":
        p.fmt_type = getattr(tlp.TlpType, f"CFG_{'WRITE' if i.get('write') else 'READ'}_{1 if i.get('type1') else 0}")
        p.completer_id = PcieId.from_int(i["bdf"])
        p.address = i["reg"]
        p.length = 1
        p.first_be = 15
    elif v["builder"] == "mem":
        p.fmt_type = getattr(tlp.TlpType, f"MEM_{'WRITE' if i.get('write') else 'READ'}{'_64' if i.get('is64') else ''}")
        p.address = i["address"]
        p.length = i["lengthDw"]
        p.first_be = 15
        p.last_be = 0 if p.length == 1 else 15
    else:
        p.fmt_type = tlp.TlpType.CPL_DATA if i.get("dataDws") else tlp.TlpType.CPL
        p.completer_id = PcieId.from_int(i["completer"])
        p.byte_count = i["byteCount"]
        p.length = len(i.get("dataDws", []))
    # Compare headers only: payload byte serialization is a separate convention.
    actual = [p.pack_header()[n:n+4].hex() for n in range(0, p.get_header_size(), 4)]
    expected = v["dwords"][:p.get_header_size_dw()]
    assert actual == expected, (v["id"], actual, expected)
    results.append(v["id"])
print(json.dumps({
    "comparison": "protocol header DWORDs; upstream network byte order normalized",
    "referenceTlpSha256": hashlib.sha256((codec / "tlp.py").read_bytes()).hexdigest(),
    "passed": len(results), "vectors": results,
}, indent=2))
