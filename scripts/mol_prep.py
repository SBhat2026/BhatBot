#!/usr/bin/env python3
"""BhatBot molecule prep — small-molecule 3D structure + properties for the `molecule` tool.

Runs in ~/.bhatbot/sim-venv (RDKit pre-installed). Reads a JSON request on argv[1] or stdin:
  {"smiles": "...", "name": "...", "want": "sdf|props"}
Resolves a 3D structure (RDKit embed for SMILES; PubChem REST for names that RDKit can't parse)
and prints a JSON result to stdout:
  {"ok": true, "format": "sdf", "data": "<molblock>", "props": {...}, "source": "rdkit|pubchem"}
Never throws — emits {"ok": false, "error": "..."} so the Node side can degrade gracefully.
Nothing leaves the machine except an optional PubChem name lookup (only when a name is given).
"""
import sys, json, urllib.request, urllib.parse

def err(msg):
    print(json.dumps({"ok": False, "error": str(msg)})); sys.exit(0)

def rdkit_props(mol):
    from rdkit.Chem import Descriptors, Crippen, rdMolDescriptors
    return {
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "mw": round(Descriptors.MolWt(mol), 2),
        "logp": round(Crippen.MolLogP(mol), 2),
        "hbd": rdMolDescriptors.CalcNumHBD(mol),
        "hba": rdMolDescriptors.CalcNumHBA(mol),
        "tpsa": round(rdMolDescriptors.CalcTPSA(mol), 2),
        "rot_bonds": rdMolDescriptors.CalcNumRotatableBonds(mol),
        "rings": rdMolDescriptors.CalcNumRings(mol),
    }

def embed_3d(mol):
    from rdkit import Chem
    from rdkit.Chem import AllChem
    mol = Chem.AddHs(mol)
    if AllChem.EmbedMolecule(mol, AllChem.ETKDGv3()) != 0:
        # fallback: random coords if ETKDG fails on awkward inputs
        AllChem.EmbedMolecule(mol, useRandomCoords=True)
    try:
        AllChem.MMFFOptimizeMolecule(mol)
    except Exception:
        pass
    return mol

def from_smiles(smiles):
    from rdkit import Chem
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    props = rdkit_props(mol)
    mol3d = embed_3d(mol)
    return {"format": "sdf", "data": Chem.MolToMolBlock(mol3d), "props": props, "source": "rdkit"}

def pubchem_smiles(name):
    url = ("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/"
           + urllib.parse.quote(name) + "/property/CanonicalSMILES/TXT")
    with urllib.request.urlopen(url, timeout=15) as r:
        return r.read().decode().strip().splitlines()[0].strip()

def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        err("bad request json: %s" % e)
    smiles = (req.get("smiles") or "").strip()
    name = (req.get("name") or "").strip()
    try:
        out = None
        if smiles:
            out = from_smiles(smiles)
            if out is None:
                err("RDKit could not parse SMILES: %r" % smiles)
        elif name:
            # try RDKit-parseable name? RDKit has no name lookup → go straight to PubChem for SMILES
            try:
                sm = pubchem_smiles(name)
            except Exception as e:
                err("PubChem lookup failed for %r: %s" % (name, e))
            out = from_smiles(sm)
            if out is None:
                err("got SMILES from PubChem but RDKit could not embed it: %r" % sm)
            out["source"] = "pubchem+rdkit"
            out["resolved_smiles"] = sm
        else:
            err("need 'smiles' or 'name'")
        print(json.dumps({"ok": True, **out}))
    except Exception as e:
        err(e)

if __name__ == "__main__":
    main()
