# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.ts >> E) Workspace page and interactive controls >> Chat dock: send a query and receive offline stream answer with citations
- Location: e2e\workspace.spec.ts:115:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: E2E unexpected console.error(s):
Failed to load resource: the server responded with a status of 404 (Not Found)
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for locator('button:has-text("Send"), button[aria-label="Send message"]').first()

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - application "3D knowledge graph" [ref=e4]
    - banner [ref=e9]:
      - link "Back to workspaces" [ref=e10] [cursor=pointer]:
        - /url: /app
      - link [ref=e13] [cursor=pointer]:
        - /url: /
      - generic [ref=e23] [cursor=pointer]: E2E Code Workspace
      - generic [ref=e28]:
        - textbox "Search the graph" [ref=e29]:
          - /placeholder: Search symbols, files, ideas…
        - generic [ref=e30]: /
      - tablist "Mode" [ref=e31]:
        - tab "Explore" [selected] [ref=e32] [cursor=pointer]
        - tab "Impact" [ref=e37] [cursor=pointer]
        - tab "Trace" [ref=e41] [cursor=pointer]
        - tab "Flows" [ref=e45] [cursor=pointer]
      - generic [ref=e51]:
        - button "Fit graph to screen (F)" [ref=e52] [cursor=pointer]
        - button "Auto-rotate (Space)" [pressed] [ref=e59] [cursor=pointer]
        - button "Export" [ref=e66] [cursor=pointer]
        - button "Display settings" [ref=e70] [cursor=pointer]
    - complementary "Workspace panel" [ref=e74]:
      - generic [ref=e75]:
        - button "Sources" [pressed] [ref=e76] [cursor=pointer]
        - button "Chats" [ref=e82] [cursor=pointer]
        - button "Insights" [ref=e85] [cursor=pointer]
        - button "Flows" [ref=e88] [cursor=pointer]
        - button "Filters" [ref=e93] [cursor=pointer]
        - button "Close side panel" [ref=e96] [cursor=pointer]
      - generic [ref=e100]:
        - generic [ref=e101]:
          - heading "Sources" [level=3] [ref=e102]
          - generic [ref=e103]:
            - button "Re-index all sources" [ref=e104] [cursor=pointer]
            - button "Add a source" [ref=e110] [cursor=pointer]
        - generic [ref=e112]:
          - generic [ref=e113]:
            - generic [ref=e114]:
              - generic [ref=e115]: sample_code
              - generic [ref=e116]: local · 0 files
            - generic [ref=e117]:
              - button "Replace sample_code" [ref=e118] [cursor=pointer]
              - button "Remove sample_code" [ref=e124] [cursor=pointer]
          - generic [ref=e128]:
            - button "client.js" [ref=e130]
            - button "main.py" [ref=e136]
            - button "service.py" [ref=e142]
            - button "utils.py" [ref=e148]
    - region "Chat with your graph" [ref=e153]:
      - generic [ref=e154]:
        - button "What are the main parts of this project?" [ref=e155]
        - 'button "What would break if I change `run_app`?" [ref=e156]'
        - button "Summarize the key ideas in my documents" [ref=e157]
      - generic [ref=e158]:
        - button "Collapse chat" [ref=e159] [cursor=pointer]
        - textbox "Message" [active] [ref=e162]:
          - /placeholder: Ask your graph anything — it will light up the answer
          - text: What does this repository do?
        - button "Send" [ref=e163] [cursor=pointer]
    - generic "Legend":
      - generic: 15 nodes · 26 links
      - generic:
        - generic: Function
        - generic: "6"
      - generic:
        - generic: File
        - generic: "4"
      - generic:
        - generic: Method
        - generic: "2"
      - generic:
        - generic: Process
        - generic: "1"
      - generic:
        - generic: Class
        - generic: "1"
      - generic:
        - generic: Source
        - generic: "1"
  - status
```

# Test source

```ts
  23  |     while (attempts < 30) {
  24  |       const check = await request.get(`http://127.0.0.1:8000/api/workspaces/${wsId}`)
  25  |       const data = await check.json()
  26  |       if (data.status === 'ready') break
  27  |       await new Promise((r) => setTimeout(r, 1000))
  28  |       attempts++
  29  |     }
  30  |   })
  31  | 
  32  |   test('Top bar controls: mode buttons, search, auto-rotate, fit, export, and rename', async ({ page }) => {
  33  |     await page.goto(`/app/w/${wsId}`)
  34  | 
  35  |     // Wait for graph canvas to be active
  36  |     await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 })
  37  | 
  38  |     // Mode buttons: Explore, Impact, Trace, Flows
  39  |     const exploreBtn = page.locator('button:has-text("Explore")').first()
  40  |     const impactBtn = page.locator('button:has-text("Impact")').first()
  41  |     const traceBtn = page.locator('button:has-text("Trace")').first()
  42  |     const flowsBtn = page.locator('button:has-text("Flows")').first()
  43  | 
  44  |     await expect(exploreBtn).toBeVisible()
  45  |     await expect(impactBtn).toBeVisible()
  46  |     await expect(traceBtn).toBeVisible()
  47  |     await expect(flowsBtn).toBeVisible()
  48  | 
  49  |     // Click Impact button -> should activate impact mode hint
  50  |     await impactBtn.click()
  51  |     await expect(page.locator('text=/Select a node to inspect/i, text=/Impact/i').first()).toBeVisible()
  52  | 
  53  |     // Return to Explore
  54  |     await exploreBtn.click()
  55  | 
  56  |     // Search bar
  57  |     const searchInput = page.locator('input[placeholder*="Search"]').first()
  58  |     await expect(searchInput).toBeVisible()
  59  |     await searchInput.fill('auth')
  60  |     await page.keyboard.press('Enter')
  61  | 
  62  |     // Auto-rotate toggle button
  63  |     const autoRotateBtn = page.locator('button[aria-label*="rotate" i], button:has-text("Rotate")').first()
  64  |     if (await autoRotateBtn.isVisible()) {
  65  |       await autoRotateBtn.click()
  66  |     }
  67  | 
  68  |     // Fit button
  69  |     const fitBtn = page.locator('button[aria-label*="Fit" i], button:has-text("Fit")').first()
  70  |     if (await fitBtn.isVisible()) {
  71  |       await fitBtn.click()
  72  |     }
  73  | 
  74  |     // Export dropdown / triggers
  75  |     const exportBtn = page.locator('button:has-text("Export")').first()
  76  |     if (await exportBtn.isVisible()) {
  77  |       await exportBtn.click()
  78  |       await expect(page.locator('text=JSON, text=GraphML, text=Cypher').first()).toBeVisible()
  79  |       // Close dropdown
  80  |       await page.keyboard.press('Escape')
  81  |     }
  82  |   })
  83  | 
  84  |   test('Left rail tabs: Sources, Chats, Insights, Flows, Filters', async ({ page }) => {
  85  |     await page.goto(`/app/w/${wsId}`)
  86  |     await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 })
  87  | 
  88  |     // Check rail buttons
  89  |     const sourcesBtn = page.locator('button:has-text("Sources")').first()
  90  |     const chatsBtn = page.locator('button:has-text("Chats")').first()
  91  |     const insightsBtn = page.locator('button:has-text("Insights")').first()
  92  |     const filtersBtn = page.locator('button:has-text("Filters")').first()
  93  | 
  94  |     await expect(sourcesBtn).toBeVisible()
  95  |     await expect(chatsBtn).toBeVisible()
  96  |     await expect(insightsBtn).toBeVisible()
  97  |     await expect(filtersBtn).toBeVisible()
  98  | 
  99  |     // Click Filters tab
  100 |     await filtersBtn.click()
  101 |     await expect(page.locator('text=/Node types|Filter/i').first()).toBeVisible()
  102 | 
  103 |     // Click Insights tab
  104 |     await insightsBtn.click()
  105 |     await expect(page.locator('text=/Insights|Findings/i').first()).toBeVisible()
  106 | 
  107 |     // Click Chats tab
  108 |     await chatsBtn.click()
  109 |     await expect(page.locator('text=/New chat|Chats/i').first()).toBeVisible()
  110 | 
  111 |     // Return to Sources
  112 |     await sourcesBtn.click()
  113 |   })
  114 | 
  115 |   test('Chat dock: send a query and receive offline stream answer with citations', async ({ page }) => {
  116 |     await page.goto(`/app/w/${wsId}`)
  117 |     await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 })
  118 | 
  119 |     const chatInput = page.locator('textarea[placeholder*="Ask"], input[placeholder*="Ask"]').first()
  120 |     if (await chatInput.isVisible()) {
  121 |       await chatInput.fill('What does this repository do?')
  122 |       const sendBtn = page.locator('button:has-text("Send"), button[aria-label="Send message"]').first()
> 123 |       await sendBtn.click()
      |                     ^ Error: locator.click: Test timeout of 60000ms exceeded.
  124 | 
  125 |       // Answer arrives (offline answer)
  126 |       await expect(page.locator('text=/Answered offline|repository|code/i').first()).toBeVisible({ timeout: 30000 })
  127 |     }
  128 |   })
  129 | })
  130 | 
```