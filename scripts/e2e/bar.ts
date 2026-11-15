import type { CDPSession, Page } from "playwright";

interface DomNode {
  nodeName: string;
  nodeValue?: string;
  nodeType: number;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

function* walk(node: DomNode): Generator<DomNode> {
  yield node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
    yield* walk(child);
  }
}

function attr(node: DomNode, name: string): string | undefined {
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
}

async function pierce(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  return { session, root };
}

async function ensureAttrs(session: CDPSession, node: DomNode) {
  if (node.attributes) return;
  const described = (await session.send("DOM.describeNode", { backendNodeId: node.backendNodeId })) as { node: DomNode };
  node.attributes = described.node.attributes ?? [];
}

async function resolveAndCall(session: CDPSession, node: DomNode, source: string, args: unknown[] = []) {
  const { object } = (await session.send("DOM.resolveNode", { backendNodeId: node.backendNodeId })) as { object: { objectId?: string } };
  if (!object.objectId) throw new Error("Could not resolve an extension UI node");
  const result = (await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: source,
    arguments: args.map((value) => ({ value })),
    awaitPromise: false,
  })) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "extension UI call failed");
}

async function barOpen(page: Page): Promise<boolean> {
  const { session, root } = await pierce(page);
  try {
    for (const node of walk(root)) {
      if (node.nodeName !== "DIV") continue;
      await ensureAttrs(session, node);
      const classes = (attr(node, "class") ?? "").split(/\s+/);
      if (classes.includes("sp") && classes.includes("open")) return true;
    }
    return false;
  } finally {
    await session.detach();
  }
}

export async function openBar(page: Page): Promise<void> {
  await page.bringToFront();
  if (await barOpen(page)) return;
  await clickFab(page);
  const deadline = Date.now() + 5000;
  while (!(await barOpen(page))) {
    if (Date.now() > deadline) throw new Error("The bar did not open");
    await page.waitForTimeout(50);
  }
}

export async function clickShadowText(page: Page, fragment: string): Promise<void> {
  const { session, root } = await pierce(page);
  try {
    const target = parentOfText(root, fragment);
    if (!target) throw new Error(`No "${fragment}" text in the page's extension UI`);
    await resolveAndCall(session, target, "function () { this.click(); }");
  } finally {
    await session.detach();
  }
}

function parentOfText(root: DomNode, fragment: string): DomNode | undefined {
  const visit = (node: DomNode): DomNode | undefined => {
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
      if (child.nodeType === 3 && child.nodeValue?.includes(fragment)) return node;
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(root);
}

async function clickFab(page: Page): Promise<void> {
  const opened = await pierce(page);
  try {
    let fab: DomNode | undefined;
    for (const node of walk(opened.root)) {
      if (node.nodeName !== "BUTTON") continue;
      await ensureAttrs(opened.session, node);
      if ((attr(node, "aria-label") ?? "").includes("Open Cappy")) fab = node;
    }
    if (!fab) throw new Error("No Cappy button on the page");
    await resolveAndCall(opened.session, fab, "function () { this.click(); }");
  } finally {
    await opened.session.detach();
  }
}
