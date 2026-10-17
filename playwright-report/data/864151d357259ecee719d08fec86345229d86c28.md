# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: new-workspace.spec.ts >> D) New workspace flow >> Documents workspace mode displays document upload interface and rejects kind mismatch
- Location: e2e\new-workspace.spec.ts:68:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[role="dialog"]').locator('text=/Drop PDFs, Word files/i')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('[role="dialog"]').locator('text=/Drop PDFs, Word files/i') with timeout 10000ms
  - waiting for locator('[role="dialog"]').locator('text=/Drop PDFs, Word files/i')

```

```yaml
- banner:
  - link "NexMind":
    - /url: /
  - text: Server 1.1.0 · openai
  - button "Display settings"
- main:
  - heading "Workspaces" [level=1]
  - paragraph: Switch between your project codebases and document study sets.
  - tablist "Workspace kind":
    - tab "Projects (56)" [selected]
    - tab "Documents (16)"
    - tab "Live connect (0)"
  - button "New workspace"
  - link "code_project Project Ready nodes 15 links 26 chats 0 1 source · 10/18/2026 Delete code_project":
    - heading "code_project" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/18/2026
    - button "Delete code_project"
  - link "Test Code WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Test Code WS":
    - heading "Test Code WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Test Code WS"
  - link "5k Perf Graph Project Ready nodes – links – chats 0 0 sources · 10/17/2026 Delete 5k Perf Graph":
    - heading "5k Perf Graph" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete 5k Perf Graph"
  - link "Source Delete WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Source Delete WS":
    - heading "Source Delete WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Source Delete WS"
  - link "Concurrency WS Project Ready nodes 30 links 52 chats 0 2 sources · 10/17/2026 Delete Concurrency WS":
    - heading "Concurrency WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "30"
    - term: links
    - definition: "52"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Concurrency WS"
  - link "Git Ingest WS Project Ready nodes 6 links 4 chats 0 2 sources · 10/17/2026 Delete Git Ingest WS":
    - heading "Git Ingest WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "6"
    - term: links
    - definition: "4"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Git Ingest WS"
  - link "Traversal Test WS Project Ready nodes 2 links 1 chats 0 1 source · 10/17/2026 Delete Traversal Test WS":
    - heading "Traversal Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "2"
    - term: links
    - definition: "1"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete Traversal Test WS"
  - link "Ingest Matrix WS Project Ready nodes 30 links 52 chats 0 2 sources · 10/17/2026 Delete Ingest Matrix WS":
    - heading "Ingest Matrix WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "30"
    - term: links
    - definition: "52"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Ingest Matrix WS"
  - link "Graph Test Workspace Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Graph Test Workspace":
    - heading "Graph Test Workspace" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Graph Test Workspace"
  - link "local Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete local":
    - heading "local" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete local"
  - link "Shop demo Project Ready nodes 66 links 188 chats 1 1 source · 10/17/2026 Delete Shop demo":
    - heading "Shop demo" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "66"
    - term: links
    - definition: "188"
    - term: chats
    - definition: "1"
    - text: 1 source · 10/17/2026
    - button "Delete Shop demo"
  - link "Empty Chat WS Project Empty nodes – links – chats 1 0 sources · 10/17/2026 Delete Empty Chat WS":
    - heading "Empty Chat WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "1"
    - text: 0 sources · 10/17/2026
    - button "Delete Empty Chat WS"
  - link "Chat Test WS Project Ready nodes 15 links 26 chats 3 1 source · 10/17/2026 Delete Chat Test WS":
    - heading "Chat Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "3"
    - text: 1 source · 10/17/2026
    - button "Delete Chat Test WS"
  - link "Code WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Code WS":
    - heading "Code WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Code WS"
  - link "Test Code WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Test Code WS":
    - heading "Test Code WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Test Code WS"
  - link "WS Test WS Project Ready nodes 15 links 26 chats 0 1 source · 10/17/2026 Delete WS Test WS":
    - heading "WS Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete WS Test WS"
  - link "Quality Invariants WS Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Quality Invariants WS":
    - heading "Quality Invariants WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Quality Invariants WS"
  - link "5k Perf Graph Project Ready nodes – links – chats 0 0 sources · 10/17/2026 Delete 5k Perf Graph":
    - heading "5k Perf Graph" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete 5k Perf Graph"
  - link "Source Delete WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Source Delete WS":
    - heading "Source Delete WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Source Delete WS"
  - link "Concurrency WS Project Ready nodes 30 links 52 chats 0 2 sources · 10/17/2026 Delete Concurrency WS":
    - heading "Concurrency WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "30"
    - term: links
    - definition: "52"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Concurrency WS"
  - link "Git Ingest WS Project Ready nodes 6 links 4 chats 0 2 sources · 10/17/2026 Delete Git Ingest WS":
    - heading "Git Ingest WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "6"
    - term: links
    - definition: "4"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Git Ingest WS"
  - link "Traversal Test WS Project Ready nodes 2 links 1 chats 0 1 source · 10/17/2026 Delete Traversal Test WS":
    - heading "Traversal Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "2"
    - term: links
    - definition: "1"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete Traversal Test WS"
  - link "Ingest Matrix WS Project Ready nodes 30 links 52 chats 0 2 sources · 10/17/2026 Delete Ingest Matrix WS":
    - heading "Ingest Matrix WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "30"
    - term: links
    - definition: "52"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Ingest Matrix WS"
  - link "Graph Test Workspace Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Graph Test Workspace":
    - heading "Graph Test Workspace" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Graph Test Workspace"
  - link "local Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete local":
    - heading "local" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete local"
  - link "Shop demo Project Ready nodes 66 links 188 chats 1 1 source · 10/17/2026 Delete Shop demo":
    - heading "Shop demo" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "66"
    - term: links
    - definition: "188"
    - term: chats
    - definition: "1"
    - text: 1 source · 10/17/2026
    - button "Delete Shop demo"
  - link "Empty Chat WS Project Empty nodes – links – chats 1 0 sources · 10/17/2026 Delete Empty Chat WS":
    - heading "Empty Chat WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "1"
    - text: 0 sources · 10/17/2026
    - button "Delete Empty Chat WS"
  - link "Chat Test WS Project Ready nodes 15 links 26 chats 3 1 source · 10/17/2026 Delete Chat Test WS":
    - heading "Chat Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "3"
    - text: 1 source · 10/17/2026
    - button "Delete Chat Test WS"
  - link "5k Perf Graph Project Ready nodes – links – chats 0 0 sources · 10/17/2026 Delete 5k Perf Graph":
    - heading "5k Perf Graph" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete 5k Perf Graph"
  - link "5k Perf Graph Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete 5k Perf Graph":
    - heading "5k Perf Graph" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete 5k Perf Graph"
  - link "WS Test WS Project Ready nodes 15 links 26 chats 0 1 source · 10/17/2026 Delete WS Test WS":
    - heading "WS Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete WS Test WS"
  - link "WS Test WS Project Ready nodes 15 links 26 chats 0 1 source · 10/17/2026 Delete WS Test WS":
    - heading "WS Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete WS Test WS"
  - link "Empty Chat WS Project Empty nodes – links – chats 1 0 sources · 10/17/2026 Delete Empty Chat WS":
    - heading "Empty Chat WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "1"
    - text: 0 sources · 10/17/2026
    - button "Delete Empty Chat WS"
  - link "Chat Test WS Project Ready nodes 15 links 26 chats 3 1 source · 10/17/2026 Delete Chat Test WS":
    - heading "Chat Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "15"
    - term: links
    - definition: "26"
    - term: chats
    - definition: "3"
    - text: 1 source · 10/17/2026
    - button "Delete Chat Test WS"
  - link "Quality Invariants WS Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Quality Invariants WS":
    - heading "Quality Invariants WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Quality Invariants WS"
  - link "Graph Test Workspace Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Graph Test Workspace":
    - heading "Graph Test Workspace" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Graph Test Workspace"
  - link "Graph Test Workspace Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Graph Test Workspace":
    - heading "Graph Test Workspace" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Graph Test Workspace"
  - link "Graph Test Workspace Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Graph Test Workspace":
    - heading "Graph Test Workspace" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Graph Test Workspace"
  - link "Graph Test Workspace Project Ready nodes 40 links 100 chats 0 2 sources · 10/17/2026 Delete Graph Test Workspace":
    - heading "Graph Test Workspace" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "40"
    - term: links
    - definition: "100"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Graph Test Workspace"
  - link "Source Delete WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Source Delete WS":
    - heading "Source Delete WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Source Delete WS"
  - link "Concurrency WS Project Ready nodes 30 links 52 chats 0 2 sources · 10/17/2026 Delete Concurrency WS":
    - heading "Concurrency WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "30"
    - term: links
    - definition: "52"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Concurrency WS"
  - link "Git Ingest WS Project Ready nodes 6 links 4 chats 0 2 sources · 10/17/2026 Delete Git Ingest WS":
    - heading "Git Ingest WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "6"
    - term: links
    - definition: "4"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Git Ingest WS"
  - link "Traversal Test WS Project Ready nodes 2 links 1 chats 0 1 source · 10/17/2026 Delete Traversal Test WS":
    - heading "Traversal Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "2"
    - term: links
    - definition: "1"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete Traversal Test WS"
  - link "Ingest Matrix WS Project Ready nodes 30 links 52 chats 0 2 sources · 10/17/2026 Delete Ingest Matrix WS":
    - heading "Ingest Matrix WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "30"
    - term: links
    - definition: "52"
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Ingest Matrix WS"
  - link "Source Delete WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Source Delete WS":
    - heading "Source Delete WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Source Delete WS"
  - link "Concurrency WS Project Error nodes – links – chats 0 2 sources · 10/17/2026 Delete Concurrency WS":
    - heading "Concurrency WS" [level=2]
    - text: Project Error
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 2 sources · 10/17/2026
    - button "Delete Concurrency WS"
  - link "Git Ingest WS Project Error nodes – links – chats 0 1 source · 10/17/2026 Delete Git Ingest WS":
    - heading "Git Ingest WS" [level=2]
    - text: Project Error
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete Git Ingest WS"
  - link "Traversal Test WS Project Ready nodes 2 links 1 chats 0 1 source · 10/17/2026 Delete Traversal Test WS":
    - heading "Traversal Test WS" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "2"
    - term: links
    - definition: "1"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete Traversal Test WS"
  - link "Ingest Matrix WS Project Error nodes – links – chats 0 1 source · 10/17/2026 Delete Ingest Matrix WS":
    - heading "Ingest Matrix WS" [level=2]
    - text: Project Error
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete Ingest Matrix WS"
  - link "Code WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Code WS":
    - heading "Code WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Code WS"
  - link "Test Code WS Project Empty nodes – links – chats 0 0 sources · 10/17/2026 Delete Test Code WS":
    - heading "Test Code WS" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 10/17/2026
    - button "Delete Test Code WS"
  - link "IntelliWard Project Ready nodes 730 links 2323 chats 0 1 source · 10/17/2026 Delete IntelliWard":
    - heading "IntelliWard" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "730"
    - term: links
    - definition: "2323"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/17/2026
    - button "Delete IntelliWard"
  - link "hack Project Ready nodes 256 links 553 chats 0 1 source · 10/10/2026 Delete hack":
    - heading "hack" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "256"
    - term: links
    - definition: "553"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/10/2026
    - button "Delete hack"
  - link "QueryMind Project Ready nodes 654 links 2011 chats 0 1 source · 10/9/2026 Delete QueryMind":
    - heading "QueryMind" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "654"
    - term: links
    - definition: "2011"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/9/2026
    - button "Delete QueryMind"
  - link "TradeDesk Project Ready nodes 800 links 2225 chats 0 1 source · 10/9/2026 Delete TradeDesk":
    - heading "TradeDesk" [level=2]
    - text: Project Ready
    - term: nodes
    - definition: "800"
    - term: links
    - definition: "2225"
    - term: chats
    - definition: "0"
    - text: 1 source · 10/9/2026
    - button "Delete TradeDesk"
  - link "ws_recovery_test Project Empty nodes – links – chats 0 0 sources · 1/1/1970 Delete ws_recovery_test":
    - heading "ws_recovery_test" [level=2]
    - text: Project Empty
    - term: nodes
    - definition: –
    - term: links
    - definition: –
    - term: chats
    - definition: "0"
    - text: 0 sources · 1/1/1970
    - button "Delete ws_recovery_test"
- dialog "Dialog":
  - banner:
    - heading "What do you want to explore?" [level=2]
    - button "Close dialog"
  - paragraph: Choose the kind of workspace to create. You can explore source code, read documents, or connect live from your editor.
  - 'button "Projects: Analyze a codebase from GitHub, GitLab, Azure DevOps, a project zip or a folder."':
    - text: "1"
    - heading "Projects" [level=3]
    - paragraph: Analyze a codebase from GitHub, GitLab, Azure DevOps, a project zip or a folder.
    - text: Select Press 1
  - 'button "Documents: Study from PDFs, Word files, notes or zipped folders of documents."':
    - text: "2"
    - heading "Documents" [level=3]
    - paragraph: Study from PDFs, Word files, notes or zipped folders of documents.
    - text: Select Press 2
  - 'button "Live connect: Connect the project open in VS Code with one command. The graph updates as you edit."':
    - text: "3"
    - heading "Live connect" [level=3]
    - paragraph: Connect the project open in VS Code with one command. The graph updates as you edit.
    - text: Select Press 3
- status
```

# Test source

```ts
  1  | import { test, expect } from './fixtures/test-base'
  2  | import path from 'path'
  3  | 
  4  | test.describe('D) New workspace flow', () => {
  5  |   test('Step 1 displays three mode cards, supports key navigation, Esc to close, and Back button', async ({ page }) => {
  6  |     await page.goto('/app')
  7  | 
  8  |     const newWsBtn = page.locator('button:has-text("New workspace")').first()
  9  |     await newWsBtn.click()
  10 | 
  11 |     // Step 1: Mode selection
  12 |     const dialog = page.locator('[role="dialog"]')
  13 |     await expect(dialog).toBeVisible()
  14 |     await expect(dialog.locator('text=What do you want to explore?')).toBeVisible()
  15 | 
  16 |     const projectCard = dialog.locator('text=Projects').first()
  17 |     const docsCard = dialog.locator('text=Documents').first()
  18 |     const liveCard = dialog.locator('text=Live connect').first()
  19 | 
  20 |     await expect(projectCard).toBeVisible()
  21 |     await expect(docsCard).toBeVisible()
  22 |     await expect(liveCard).toBeVisible()
  23 | 
  24 |     // Press Escape closes the modal
  25 |     await page.keyboard.press('Escape')
  26 |     await expect(dialog).not.toBeVisible()
  27 | 
  28 |     // Reopen and test Back button
  29 |     await newWsBtn.click()
  30 |     await expect(dialog).toBeVisible()
  31 |     await projectCard.click()
  32 | 
  33 |     // Now in Step 2: Projects form
  34 |     await expect(dialog.locator('role=tab[name="GitHub"]')).toBeVisible()
  35 |     const backBtn = dialog.locator('button:has-text("Back"), button[aria-label="Back"]').first()
  36 |     await backBtn.click()
  37 | 
  38 |     // Returned to Step 1
  39 |     await expect(dialog.locator('text=What do you want to explore?')).toBeVisible()
  40 |   })
  41 | 
  42 |   test('Creating a project workspace via archive upload navigates to workspace', async ({ page }) => {
  43 |     await page.goto('/app')
  44 | 
  45 |     await page.locator('button:has-text("New workspace")').first().click()
  46 |     const dialog = page.locator('[role="dialog"]')
  47 |     await dialog.locator('text=Projects').first().click()
  48 | 
  49 |     // Switch to Upload project tab
  50 |     await dialog.locator('role=tab[name="Upload project"]').click()
  51 | 
  52 |     // Upload fixture zip
  53 |     const fixtureZip = path.resolve(process.cwd(), 'e2e/fixtures/code_project.zip')
  54 |     const fileChooserPromise = page.waitForEvent('filechooser')
  55 |     await dialog.locator('button:has-text("Choose files")').click()
  56 |     const fileChooser = await fileChooserPromise
  57 |     await fileChooser.setFiles(fixtureZip)
  58 | 
  59 |     // Analyze button should be active
  60 |     const analyzeBtn = dialog.locator('button:has-text("Analyze")')
  61 |     await expect(analyzeBtn).toBeEnabled()
  62 |     await analyzeBtn.click()
  63 | 
  64 |     // Navigates to workspace page
  65 |     await expect(page).toHaveURL(/\/app\/w\/[a-zA-Z0-9_-]+/, { timeout: 30000 })
  66 |   })
  67 | 
  68 |   test('Documents workspace mode displays document upload interface and rejects kind mismatch', async ({ page }) => {
  69 |     await page.goto('/app')
  70 | 
  71 |     await page.locator('button:has-text("New workspace")').first().click()
  72 |     const dialog = page.locator('[role="dialog"]')
  73 |     await dialog.locator('text=Documents').first().click()
  74 | 
  75 |     // In docs mode, upload zone is shown directly with no Git tabs
> 76 |     await expect(dialog.locator('text=/Drop PDFs, Word files/i')).toBeVisible()
     |                                                                   ^ Error: expect(locator).toBeVisible() failed
  77 |     await expect(dialog.locator('role=tab[name="GitHub"]')).not.toBeVisible()
  78 |   })
  79 | })
  80 | 
```