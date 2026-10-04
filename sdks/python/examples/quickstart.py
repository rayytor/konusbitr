"""The README's quickstart, runnable.

    KONUSBITR_API_KEY=kb_live_... python quickstart.py path/to/document.pdf

KONUSBITR_URL defaults to a local stack. Set KONUSBITR_QUESTION to also ask the
document something, which needs a chat model configured on the instance.
"""

import os
import sys

from konusbitr import Konusbitr

if len(sys.argv) != 2 or not os.environ.get("KONUSBITR_API_KEY"):
    sys.exit("usage: KONUSBITR_API_KEY=... python quickstart.py <document.pdf>")

with Konusbitr(
    base_url=os.environ.get("KONUSBITR_URL", "http://localhost:3000"),
    api_key=os.environ["KONUSBITR_API_KEY"],
) as client:
    # Parse once. The docId is a handle: every later call against it is free.
    with open(sys.argv[1], "rb") as handle:
        doc = client.parse(file=handle)
    print(f"{doc['docId']}: {doc['pageCount']} pages, {len(doc['contents'])} elements")

    again = client.parse(docId=doc["docId"])
    print(f"again by docId: cached={again['cached']}")

    stored = client.get_document(doc["docId"])
    print(f"status: {stored['status']}")

    question = os.environ.get("KONUSBITR_QUESTION")
    if question:
        answer = client.ask(docId=doc["docId"], question=question)
        print(answer["answer"])
        for citation in answer["citations"]:
            print(f"  page {citation['page']}: {citation['quote']}")
