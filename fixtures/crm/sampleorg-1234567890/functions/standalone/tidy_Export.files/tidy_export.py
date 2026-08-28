# Sample function - invented, and never run against anything.
def execute(rows):
    kept = [r for r in rows if r.get("status") != "draft"]
    return {"kept": len(kept), "note": "a # inside a string is not a comment"}
