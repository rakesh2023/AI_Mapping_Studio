"""Diagnostic: inspect a Guidewire dictionary .zip to see why a table's descriptions
aren't backfilled. Run from the server/ directory:

    cd server
    python diag_entitymodel.py "C:\\path\\to\\your\\dictionary.zip" AutoRepairShop

Prints: whether entityModel.xml was found, the raw element(s) matching the table name
(tag, depth, attributes, column children + their descriptions), what build_desc_index
produced for it, and what extract_gw_zip yields for that table.
"""
import sys
import io
import zipfile
import xml.etree.ElementTree as ET

from app.parsers.gw_dictionary import find_entity_model_xml, build_desc_index, norm_key
from app.services import extraction_service as X


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    zip_path = sys.argv[1]
    target = (sys.argv[2] if len(sys.argv) > 2 else "AutoRepairShop")
    tnorm = norm_key(target)

    raw = open(zip_path, "rb").read()
    print("=" * 70)
    print("ZIP:", zip_path, "(%d bytes)" % len(raw))

    # 0. list the .xml entries so we can see naming
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            xmls = [n for n in zf.namelist() if n.lower().endswith(".xml")]
            print("\n.xml entries in zip (first 20):")
            for n in xmls[:20]:
                print("   ", n)
            if not xmls:
                print("    (none)")
    except Exception as e:
        print("!! not a readable zip:", repr(e))
        return

    # 1. find entityModel.xml
    xml = find_entity_model_xml(raw)
    print("\nfind_entity_model_xml ->", ("FOUND (%d bytes)" % len(xml)) if xml else "NOT FOUND")
    if not xml:
        print("  => No entity model located. That's why nothing is backfilled.")
        return

    root = ET.fromstring(xml)
    ns = root.tag[:root.tag.index("}") + 1] if root.tag.startswith("{") else ""
    print("  root tag:", root.tag, "| namespace:", ns or "(none)")

    # 2. walk the tree; report every element whose id/name matches the target
    def lt(el):
        return el.tag.split("}")[-1]

    def attrs(el):
        return {k: v for k, v in el.attrib.items()}

    print("\n--- raw elements matching '%s' (by id/name, any depth) ---" % target)
    hits = 0

    def walk(el, depth, parents):
        nonlocal hits
        ident = el.get("id") or el.get("name") or ""
        if norm_key(ident) == tnorm:
            hits += 1
            print("\n  <%s> depth=%d parents=%s" % (lt(el), depth, " > ".join(parents)))
            print("    attrs:", attrs(el))
            # description
            dtxt = (el.get("description") or el.get("desc") or "").strip()
            dchild = [lt(c) for c in el if lt(c).lower() in ("description", "desc", "documentation", "doc")]
            print("    desc-attr:", repr(dtxt), "| desc-children:", dchild)
            # columns
            coltags = {}
            described = 0
            for c in el:
                clt = lt(c)
                coltags[clt] = coltags.get(clt, 0) + 1
            print("    child tags:", coltags)
            for c in el:
                if lt(c) in ("column", "typekey", "foreignKey", "foreignkey", "array"):
                    cd = (c.get("description") or c.get("desc") or "").strip()
                    if not cd:
                        for cc in c:
                            if lt(cc).lower() in ("description", "desc", "documentation", "doc"):
                                cd = "".join(cc.itertext()).strip()
                                break
                    if cd:
                        described += 1
                    print("      col name=%r columnName=%r desc=%r"
                          % (c.get("name"), c.get("columnName") or c.get("column"), (cd[:60] + "…") if len(cd) > 60 else cd))
            print("    -> columns with a description:", described)
        for c in el:
            if lt(c) in ("entity", "subtype"):
                walk(c, depth + 1, parents + [ident or lt(c)])

    walk(root, 0, [])
    if not hits:
        print("  (no entity/subtype element named '%s' found)" % target)

    # 3. what build_desc_index produced
    idx = build_desc_index(xml)
    entry = next((e for e in idx if tnorm in [norm_key(n) for n in e["names"]]), None)
    print("\n--- build_desc_index result for '%s' ---" % target)
    print("  total entries in index:", len(idx))
    if entry:
        print("  names:", entry["names"])
        print("  entity desc:", repr(entry["desc"]))
        print("  # column descriptions:", len(entry["cols"]))
        for k, v in list(entry["cols"].items())[:20]:
            print("     ", k, "->", (v[:60] + "…") if len(v) > 60 else v)
    else:
        print("  !! No index entry — descriptions can't be matched by table name.")

    # 4. extract_gw_zip end-to-end
    tables, stats = X.extract_gw_zip(raw)
    print("\n--- extract_gw_zip stats ---", stats)
    tbl = next((t for t in tables if norm_key(t["name"]) == tnorm), None)
    if not tbl:
        print("  !! No extracted table named '%s'. Extracted names (sample):" % target)
        print("    ", [t["name"] for t in tables[:30]])
        return
    filled = sum(1 for c in tbl["columns"] if (c.get("description") or "").strip())
    print("  table '%s': %d columns, %d with a description" % (tbl["name"], len(tbl["columns"]), filled))
    for c in tbl["columns"][:25]:
        print("     %-28s desc=%r" % (c["name"], (c.get("description") or "")[:50]))


if __name__ == "__main__":
    main()
