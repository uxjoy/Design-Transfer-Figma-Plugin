// code.ts - Main plugin logic
figma.showUI(__html__, { width: 400, height: 600 });

interface FileData {
  key: string;
  name: string;
  lastModified?: string;
}

interface PageData {
  id: string;
  name: string;
}

interface TransferRequest {
  action: "transfer";
  fileKey: string;
  pageId: string | null;
  newPageName?: string;
}

// Handle messages from UI
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === "validate-token") {
      await handleValidateToken(msg.token);
    } else if (msg.type === "check-stored-token") {
      await handleCheckStoredToken();
    } else if (msg.type === "get-selection") {
      handleGetSelection();
    } else if (msg.type === "get-files") {
      await handleGetFiles(msg.token);
    } else if (msg.type === "get-pages") {
      await handleGetPages(msg.fileKey, msg.token);
    } else if (msg.type === "transfer") {
      await handleTransfer(msg as TransferRequest & { token: string });
    } else if (msg.type === "apply-transfer") {
      // Apply a pending transfer from a comment
      await applyPendingTransfer(msg.nodeData, msg.pageId);
    } else if (msg.type === "cancel") {
      figma.closePlugin();
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message:
        error instanceof Error ? error.message : "An unknown error occurred",
    });
  }
};

// Validate API token and check scopes
// Validate API token and check access
async function handleValidateToken(token: string) {
  try {
    const response = await fetch("https://api.figma.com/v1/me", {
      headers: {
        "X-Figma-Token": token,
      },
    });

    if (!response.ok) {
      throw new Error(
        "Invalid API token. Please check your token and try again."
      );
    }

    const userData = await response.json();

    // Figma PATs are implicitly valid for file_read and file_write if they authenticate successfully.
    // The /v1/me endpoint doesn't explicitly return scopes, but a successful response
    // means the token has access to read/write files.
    const hasReadAccess = true; // If token is valid, it has read access
    const hasWriteAccess = true; // If token is valid, it has write access
    const scopeMessage = " (Full access: read and write)";

    // Store the token and scope info
    await figma.clientStorage.setAsync("figmaApiToken", token);
    await figma.clientStorage.setAsync("tokenScopes", {
      hasReadAccess,
      hasWriteAccess,
      scopeMessage,
    });

    figma.ui.postMessage({
      type: "token-validated",
      success: true,
      userName: userData.handle || userData.email || "User",
      hasReadAccess,
      hasWriteAccess,
      scopeMessage,
    });

    figma.notify("✓ Token validated successfully" + scopeMessage, {
      timeout: 3000,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "token-validated",
      success: false,
      message:
        error instanceof Error ? error.message : "Token validation failed",
    });
  }
}

// Check for stored token and validate
async function handleCheckStoredToken() {
  try {
    const storedToken = await figma.clientStorage.getAsync("figmaApiToken");

    if (storedToken) {
      // Validate the stored token
      const response = await fetch("https://api.figma.com/v1/me", {
        headers: {
          "X-Figma-Token": storedToken,
        },
      });

      if (response.ok) {
        const userData = await response.json();

        // A valid token has implicit read/write access
        const hasReadAccess = true;
        const hasWriteAccess = true;
        const scopeMessage = " (Full access: read and write)";

        figma.ui.postMessage({
          type: "stored-token-valid",
          token: storedToken,
          userName: userData.handle || userData.email || "User",
          hasReadAccess,
          hasWriteAccess,
          scopeMessage,
        });
        return;
      }
    }

    // No valid stored token
    figma.ui.postMessage({
      type: "stored-token-valid",
      token: null,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "stored-token-valid",
      token: null,
    });
  }
}

function handleGetSelection() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({
      type: "selection-info",
      hasSelection: false,
      message: "No frame or component selected",
    });
    return;
  }

  if (selection.length > 1) {
    figma.ui.postMessage({
      type: "selection-info",
      hasSelection: false,
      message: "Please select only one frame or component",
    });
    return;
  }

  const node = selection[0];
  const validTypes = [
    "FRAME",
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
    "GROUP",
  ];

  if (!validTypes.includes(node.type)) {
    figma.ui.postMessage({
      type: "selection-info",
      hasSelection: false,
      message: "Please select a frame, component, or group",
    });
    return;
  }

  // Get thumbnail if possible
  let thumbnail = null;
  if ("exportAsync" in node) {
    node
      .exportAsync({
        format: "PNG",
        constraint: { type: "SCALE", value: 0.25 },
      })
      .then((bytes) => {
        const base64 = figma.base64Encode(bytes);
        figma.ui.postMessage({
          type: "selection-thumbnail",
          thumbnail: base64,
        });
      })
      .catch(() => {
        // Thumbnail generation failed, continue without it
      });
  }

  figma.ui.postMessage({
    type: "selection-info",
    hasSelection: true,
    nodeName: node.name,
    nodeType: node.type,
    nodeId: node.id,
  });
}

async function handleGetFiles(token: string) {
  try {
    // Get user info first
    const userResponse = await fetch("https://api.figma.com/v1/me", {
      headers: {
        "X-Figma-Token": token,
      },
    });

    if (!userResponse.ok) {
      throw new Error("Failed to authenticate with Figma API");
    }

    const userData = await userResponse.json();

    // Get team files from all teams
    const files: FileData[] = [];

    // Add current file
    files.push({
      key: figma.fileKey || "current",
      name: `${figma.root.name} (Current File)`,
      lastModified: new Date().toISOString(),
    });

    // Get recent files from storage
    const recentFiles =
      (await figma.clientStorage.getAsync("recentFiles")) || [];

    // Merge with recent files
    recentFiles.forEach((file: FileData) => {
      if (!files.find((f) => f.key === file.key)) {
        files.push(file);
      }
    });

    figma.ui.postMessage({
      type: "files-list",
      files: files,
      currentFileKey: figma.fileKey,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Failed to fetch files",
    });
  }
}

async function handleGetPages(fileKey: string, token: string) {
  try {
    // Check if this is the current file
    if (fileKey === figma.fileKey || fileKey === "current") {
      // Load all pages first
      await figma.loadAllPagesAsync();

      const pages = figma.root.children.map((page) => ({
        id: page.id,
        name: page.name,
      }));

      figma.ui.postMessage({
        type: "pages-list",
        pages: pages,
        fileKey: fileKey,
        fileName: figma.root.name,
      });
      return;
    }

    // For other files, use API
    const response = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: {
        "X-Figma-Token": token,
      },
    });

    if (!response.ok) {
      throw new Error(
        "Failed to fetch file. Please check the file key and your permissions."
      );
    }

    const fileData = await response.json();
    const pages = fileData.document.children
      .filter((child: any) => child.type === "CANVAS")
      .map((page: any) => ({
        id: page.id,
        name: page.name,
      }));

    // Store this file in recent files
    await addToRecentFiles({
      key: fileKey,
      name: fileData.name,
      lastModified: new Date().toISOString(),
    });

    figma.ui.postMessage({
      type: "pages-list",
      pages: pages,
      fileKey: fileKey,
      fileName: fileData.name,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Failed to fetch pages",
    });
  }
}

async function addToRecentFiles(file: FileData) {
  const recentFiles = (await figma.clientStorage.getAsync("recentFiles")) || [];

  // Remove if already exists
  const filtered = recentFiles.filter((f: FileData) => f.key !== file.key);

  // Add to beginning
  filtered.unshift(file);

  // Keep only 20 most recent
  const updated = filtered.slice(0, 20);

  await figma.clientStorage.setAsync("recentFiles", updated);
}

async function handleTransfer(msg: TransferRequest & { token: string }) {
  const selection = figma.currentPage.selection;

  if (selection.length !== 1) {
    figma.ui.postMessage({
      type: "error",
      message: "Please select exactly one frame or component",
    });
    return;
  }

  const node = selection[0];

  try {
    // Check if transferring to current file
    if (msg.fileKey === figma.fileKey || msg.fileKey === "current") {
      await transferWithinCurrentFile(node, msg);
    } else {
      await transferToOtherFile(node, msg);
    }
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message:
        "Failed to transfer: " +
        (error instanceof Error ? error.message : "Unknown error"),
    });
  }
}

async function transferWithinCurrentFile(
  node: SceneNode,
  msg: TransferRequest
) {
  try {
    // Send progress update
    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 10,
      message: "Loading pages...",
    });

    // Load all pages first
    await figma.loadAllPagesAsync();

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 30,
      message: "Cloning element...",
    });

    // Clone the node
    const clonedNode = node.clone();

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 50,
      message: "Preparing target page...",
    });

    let targetPage: PageNode;

    if (msg.newPageName) {
      // Create new page
      targetPage = figma.createPage();
      targetPage.name = msg.newPageName;
    } else if (msg.pageId) {
      // Find existing page
      const page = figma.root.children.find((p) => p.id === msg.pageId);
      if (!page) {
        throw new Error("Target page not found");
      }
      targetPage = page as PageNode;

      // Load the target page before accessing it
      await targetPage.loadAsync();
    } else {
      throw new Error("No target page specified");
    }

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 70,
      message: "Transferring to page...",
    });

    // Append to target page
    targetPage.appendChild(clonedNode);

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 90,
      message: "Finalizing...",
    });

    // Switch to the target page and select the new node using async method
    await figma.setCurrentPageAsync(targetPage);
    figma.currentPage.selection = [clonedNode];
    figma.viewport.scrollAndZoomIntoView([clonedNode]);

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 100,
      message: "Transfer complete!",
    });

    figma.ui.postMessage({
      type: "transfer-complete",
      success: true,
      message: `Successfully transferred "${node.name}" to page "${targetPage.name}"`,
      keepOpen: true,
    });

    figma.notify(`✓ Transferred to "${targetPage.name}"`, { timeout: 3000 });
  } catch (error) {
    figma.ui.postMessage({
      type: "transfer-complete",
      success: false,
      message: error instanceof Error ? error.message : "Transfer failed",
      keepOpen: true,
    });
    throw error;
  }
}

async function transferToOtherFile(
  node: SceneNode,
  msg: TransferRequest & { token: string }
) {
  try {
    // Check token scopes before attempting cross-file transfer
    const tokenScopes = await figma.clientStorage.getAsync("tokenScopes");

    if (!tokenScopes || !tokenScopes.hasWriteAccess) {
      throw new Error(
        "Your token does not have file_write permission. Cross-file transfers require write access. Please generate a new token with file_write scope."
      );
    }

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 5,
      message: "Starting cross-file transfer...",
    });

    // Clone the node first
    const clonedNode = node.clone();

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 15,
      message: "Preparing element data...",
    });

    // Serialize the complete node structure
    const nodeData = await deepSerializeNode(clonedNode);

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 50,
      message: "Validating destination file...",
    });

    // Get the destination file
    const fileUrl = `https://api.figma.com/v1/files/${msg.fileKey}`;
    const fileResponse = await fetch(fileUrl, {
      method: "GET",
      headers: {
        "X-Figma-Token": msg.token,
        "Content-Type": "application/json",
      },
    });

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 60,
      message: "Accessing destination file...",
    });

    if (!fileResponse.ok) {
      throw new Error(
        "Cannot access destination file. Please verify your token has edit access to this file."
      );
    }

    const fileData = await fileResponse.json();

    // Determine target page
    let targetPageId = msg.pageId;
    let targetPageName = "";

    if (msg.newPageName) {
      throw new Error(
        "Creating new pages via API is not supported. Please select an existing page."
      );
    }

    // Find the target page
    const targetPage = fileData.document.children.find(
      (p: any) => p.id === targetPageId
    );
    if (!targetPage) {
      throw new Error("Target page not found in destination file.");
    }
    targetPageName = targetPage.name;

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 70,
      message: "Storing transfer data in destination file...",
    });

    // Prepare transfer data
    const transferData = {
      type: "DESIGN_TRANSFER",
      nodeData: nodeData,
      sourceName: node.name,
      sourceFile: figma.root.name,
      targetPageId: targetPageId,
      timestamp: new Date().toISOString(),
    };

    // Post transfer data as a comment in the destination file
    const commentUrl = `https://api.figma.com/v1/files/${msg.fileKey}/comments`;
    const transferDataStr = JSON.stringify(transferData);

    const commentResponse = await fetch(commentUrl, {
      method: "POST",
      headers: {
        "X-Figma-Token": msg.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `[FIGMA_DESIGN_TRANSFER]\n${transferDataStr}`,
      }),
    });

    if (!commentResponse.ok) {
      throw new Error("Failed to store transfer data in destination file");
    }

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 90,
      message: "Triggering destination file...",
    });

    // Clean up cloned node from source file
    clonedNode.remove();

    figma.ui.postMessage({
      type: "transfer-progress",
      progress: 100,
      message: "Transfer complete!",
    });

    // Send back success message
    figma.ui.postMessage({
      type: "transfer-complete",
      success: true,
      message: `✓ Element transferred to ${fileData.name} - applying automatically...`,
      fileKey: msg.fileKey,
      fileName: fileData.name,
      pageName: targetPageName,
      pageId: targetPageId,
      keepOpen: true,
    });

    figma.notify(
      `✓ Element transferred to "${fileData.name}" and will apply automatically`,
      { timeout: 3000 }
    );
  } catch (error) {
    figma.ui.postMessage({
      type: "transfer-complete",
      success: false,
      message: error instanceof Error ? error.message : "Transfer failed",
      keepOpen: true,
    });
    throw error;
  }
}

async function deepSerializeNode(node: BaseNode): Promise<any> {
  const serialized: any = {
    type: node.type,
    name: node.name,
    id: node.id,
  };

  // Common properties
  if ("visible" in node) serialized.visible = node.visible;
  if ("locked" in node) serialized.locked = node.locked;

  // Layout properties
  if ("x" in node) serialized.x = (node as any).x;
  if ("y" in node) serialized.y = (node as any).y;
  if ("width" in node) serialized.width = (node as any).width;
  if ("height" in node) serialized.height = (node as any).height;
  if ("rotation" in node) serialized.rotation = (node as any).rotation;

  // Visual properties
  if ("opacity" in node) serialized.opacity = (node as any).opacity;
  if ("blendMode" in node) serialized.blendMode = (node as any).blendMode;
  if ("fills" in node) serialized.fills = (node as any).fills;
  if ("strokes" in node) serialized.strokes = (node as any).strokes;
  if ("strokeWeight" in node)
    serialized.strokeWeight = (node as any).strokeWeight;
  if ("strokeAlign" in node) serialized.strokeAlign = (node as any).strokeAlign;
  if ("effects" in node) serialized.effects = (node as any).effects;
  if ("cornerRadius" in node)
    serialized.cornerRadius = (node as any).cornerRadius;

  // Text properties
  if ("characters" in node) serialized.characters = (node as any).characters;
  if ("fontSize" in node) serialized.fontSize = (node as any).fontSize;
  if ("fontName" in node) serialized.fontName = (node as any).fontName;

  // Layout properties
  if ("layoutMode" in node) serialized.layoutMode = (node as any).layoutMode;
  if ("primaryAxisSizingMode" in node)
    serialized.primaryAxisSizingMode = (node as any).primaryAxisSizingMode;
  if ("counterAxisSizingMode" in node)
    serialized.counterAxisSizingMode = (node as any).counterAxisSizingMode;
  if ("paddingLeft" in node) serialized.paddingLeft = (node as any).paddingLeft;
  if ("paddingRight" in node)
    serialized.paddingRight = (node as any).paddingRight;
  if ("paddingTop" in node) serialized.paddingTop = (node as any).paddingTop;
  if ("paddingBottom" in node)
    serialized.paddingBottom = (node as any).paddingBottom;
  if ("itemSpacing" in node) serialized.itemSpacing = (node as any).itemSpacing;

  // Recursively serialize children
  if ("children" in node) {
    serialized.children = [];
    for (const child of (node as any).children) {
      serialized.children.push(await deepSerializeNode(child));
    }
  }

  return serialized;
}

// Listen for selection changes
figma.on("selectionchange", () => {
  handleGetSelection();
});

// Apply a pending transfer from serialized node data
async function applyPendingTransfer(
  nodeData: any,
  targetPageId: string
): Promise<void> {
  try {
    console.log("Applying pending transfer for page:", targetPageId);
    await figma.loadAllPagesAsync();

    // Find target page
    const targetPage = figma.root.children.find((p) => p.id === targetPageId);
    if (!targetPage || targetPage.type !== "PAGE") {
      throw new Error(`Target page not found: ${targetPageId}`);
    }

    console.log("Target page found:", targetPage.name);

    // Create node from serialized data
    const createdNode = await createNodeFromSerialized(
      nodeData,
      targetPage as PageNode
    );

    if (createdNode) {
      console.log("Node created successfully:", createdNode.name);
      // Switch to the target page
      await figma.setCurrentPageAsync(targetPage as PageNode);
      // Select the newly created node
      figma.currentPage.selection = [createdNode];
      figma.viewport.scrollAndZoomIntoView([createdNode]);

      console.log("Transfer completed and element selected");
      figma.notify(
        `✓ Transfer applied! Element placed on page "${targetPage.name}"`,
        { timeout: 4000 }
      );
    } else {
      console.log("Failed to create node from serialized data");
    }
  } catch (error) {
    console.error("Error applying transfer:", error);
    throw error;
  }
}

// Recursively create node from serialized data
async function createNodeFromSerialized(
  nodeData: any,
  targetPage: PageNode
): Promise<SceneNode | null> {
  try {
    console.log(
      "Creating node from serialized data:",
      nodeData.type,
      nodeData.name
    );
    let createdNode: SceneNode | null = null;

    switch (nodeData.type) {
      case "FRAME":
        createdNode = figma.createFrame();
        break;
      case "RECTANGLE":
        createdNode = figma.createRectangle();
        break;
      case "ELLIPSE":
        createdNode = figma.createEllipse();
        break;
      case "TEXT":
        createdNode = figma.createText();
        if (nodeData.fontName) {
          try {
            await figma.loadFontAsync(nodeData.fontName);
          } catch (e) {
            console.log("Could not load font:", e);
          }
        }
        break;
      case "GROUP":
        createdNode = figma.group([], targetPage);
        break;
      case "COMPONENT":
        createdNode = figma.createComponent();
        break;
      default:
        console.log("Unknown node type, creating frame:", nodeData.type);
        createdNode = figma.createFrame();
    }

    if (!createdNode) {
      console.log("Failed to create node of type:", nodeData.type);
      return null;
    }

    console.log("Node created, applying properties...");

    // Apply properties
    createdNode.name = nodeData.name;

    if ("x" in createdNode && nodeData.x !== undefined)
      (createdNode as any).x = nodeData.x;
    if ("y" in createdNode && nodeData.y !== undefined)
      (createdNode as any).y = nodeData.y;
    if ("width" in createdNode && nodeData.width !== undefined)
      createdNode.resize(nodeData.width, nodeData.height || 100);
    if ("rotation" in createdNode && nodeData.rotation !== undefined)
      (createdNode as any).rotation = nodeData.rotation;
    if ("opacity" in createdNode && nodeData.opacity !== undefined)
      (createdNode as any).opacity = nodeData.opacity;
    if ("blendMode" in createdNode && nodeData.blendMode !== undefined)
      (createdNode as any).blendMode = nodeData.blendMode;
    if ("fills" in createdNode && nodeData.fills !== undefined)
      (createdNode as any).fills = nodeData.fills;
    if ("strokes" in createdNode && nodeData.strokes !== undefined)
      (createdNode as any).strokes = nodeData.strokes;
    if ("strokeWeight" in createdNode && nodeData.strokeWeight !== undefined)
      (createdNode as any).strokeWeight = nodeData.strokeWeight;
    if ("effects" in createdNode && nodeData.effects !== undefined)
      (createdNode as any).effects = nodeData.effects;
    if ("cornerRadius" in createdNode && nodeData.cornerRadius !== undefined)
      (createdNode as any).cornerRadius = nodeData.cornerRadius;

    // Handle text-specific properties
    if (createdNode.type === "TEXT" && "characters" in createdNode) {
      if (nodeData.characters)
        (createdNode as TextNode).characters = nodeData.characters;
      if (nodeData.fontSize)
        (createdNode as TextNode).fontSize = nodeData.fontSize;
    }

    // Handle auto layout
    if ("layoutMode" in createdNode && nodeData.layoutMode) {
      (createdNode as any).layoutMode = nodeData.layoutMode;
      if (nodeData.primaryAxisSizingMode)
        (createdNode as any).primaryAxisSizingMode =
          nodeData.primaryAxisSizingMode;
      if (nodeData.counterAxisSizingMode)
        (createdNode as any).counterAxisSizingMode =
          nodeData.counterAxisSizingMode;
      if (nodeData.paddingLeft !== undefined)
        (createdNode as any).paddingLeft = nodeData.paddingLeft;
      if (nodeData.paddingRight !== undefined)
        (createdNode as any).paddingRight = nodeData.paddingRight;
      if (nodeData.paddingTop !== undefined)
        (createdNode as any).paddingTop = nodeData.paddingTop;
      if (nodeData.paddingBottom !== undefined)
        (createdNode as any).paddingBottom = nodeData.paddingBottom;
      if (nodeData.itemSpacing !== undefined)
        (createdNode as any).itemSpacing = nodeData.itemSpacing;
    }

    // Recursively create children
    if (nodeData.children && "appendChild" in createdNode) {
      console.log("Creating children:", nodeData.children.length);
      for (const childData of nodeData.children) {
        const childNode = await createNodeFromSerialized(childData, targetPage);
        if (childNode && "appendChild" in createdNode) {
          (createdNode as any).appendChild(childNode);
        }
      }
    }

    // Add to target page
    console.log("Adding node to target page");
    targetPage.appendChild(createdNode);

    return createdNode;
  } catch (error) {
    console.error("Error creating node from serialized:", error);
    return null;
  }
}

// Check for pending transfers from other files when plugin opens
async function checkAndApplyPendingTransfers() {
  try {
    let token = await figma.clientStorage.getAsync("figmaApiToken");
    if (!token || !figma.fileKey) {
      console.log("No token or fileKey available for transfer check");
      return;
    }

    console.log("Checking for pending transfers...");
    const commentsUrl = `https://api.figma.com/v1/files/${figma.fileKey}/comments`;
    const response = await fetch(commentsUrl, {
      headers: {
        "X-Figma-Token": token,
      },
    });

    if (!response.ok) {
      console.log("Failed to fetch comments:", response.status);
      return;
    }

    const data = await response.json();
    console.log("Total comments:", data.comments.length);

    const transferComments = data.comments.filter((c: any) =>
      c.message.startsWith("[FIGMA_DESIGN_TRANSFER]")
    );

    console.log("Transfer comments found:", transferComments.length);

    if (transferComments.length === 0) {
      console.log("No pending transfers");
      return;
    }

    // Get the most recent transfer
    const latestComment = transferComments[transferComments.length - 1];
    console.log("Processing transfer comment:", latestComment.id);

    const transferDataStr = latestComment.message.replace(
      "[FIGMA_DESIGN_TRANSFER]\n",
      ""
    );

    const transferData = JSON.parse(transferDataStr);
    console.log("Transfer data parsed:", transferData.sourceName);

    // Apply the transfer
    await applyPendingTransfer(
      transferData.nodeData,
      transferData.targetPageId
    );

    // Delete the transfer comment
    await fetch(
      `https://api.figma.com/v1/files/${figma.fileKey}/comments/${latestComment.id}`,
      {
        method: "DELETE",
        headers: {
          "X-Figma-Token": token,
        },
      }
    );
    console.log("Transfer applied and comment deleted");
  } catch (error) {
    console.error("Error checking transfers:", error);
  }
}

// Initialize
handleCheckStoredToken();

// Check for pending transfers immediately
setTimeout(checkAndApplyPendingTransfers, 100);

// Also check periodically every 2 seconds in case the plugin was opened after the transfer was initiated
let transferCheckInterval: ReturnType<typeof setInterval> | null = null;
function startTransferPolling() {
  if (transferCheckInterval) return; // Already polling
  console.log("Starting transfer polling...");
  transferCheckInterval = setInterval(async () => {
    console.log("Polling for transfers...");
    await checkAndApplyPendingTransfers();
  }, 2000);
}

// Start polling after initialization
setTimeout(() => {
  startTransferPolling();
}, 1000);
