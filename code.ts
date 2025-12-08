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

// Helper to build fetch headers safely (avoid passing null header values)
function buildHeaders(token?: string | null) {
  const headers: { [key: string]: string } = {};
  if (token) headers["X-Figma-Token"] = String(token);
  return headers;
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

// Validate API token
async function handleValidateToken(token: string) {
  try {
    const response = await fetch("https://api.figma.com/v1/me", {
      headers: buildHeaders(token),
    });

    if (!response.ok) {
      throw new Error(
        "Invalid API token. Please check your token and try again."
      );
    }

    const userData = await response.json();

    // Store the token
    await figma.clientStorage.setAsync("figmaApiToken", token);

    figma.ui.postMessage({
      type: "token-validated",
      success: true,
      userName: userData.handle || userData.email || "User",
    });

    figma.notify("✓ Token validated successfully", { timeout: 2000 });
  } catch (error) {
    figma.ui.postMessage({
      type: "token-validated",
      success: false,
      message:
        error instanceof Error ? error.message : "Token validation failed",
    });
  }
}

// Check for stored token
async function handleCheckStoredToken() {
  try {
    const storedToken = await figma.clientStorage.getAsync("figmaApiToken");

    if (storedToken) {
      // Validate the stored token
      const response = await fetch("https://api.figma.com/v1/me", {
        headers: buildHeaders(storedToken),
      });

      if (response.ok) {
        const userData = await response.json();
        figma.ui.postMessage({
          type: "stored-token-valid",
          token: storedToken,
          userName: userData.handle || userData.email || "User",
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

  // Use indexOf for compatibility with older lib targets where Array.prototype.includes may not be available
  if (validTypes.indexOf(node.type) === -1) {
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
      headers: buildHeaders(token),
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
      });
      return;
    }

    // For other files, use API
    if (!token) {
      throw new Error(
        "No API token provided. To fetch pages from another file, provide a Figma Personal Access Token with file_read permission."
      );
    }

    const response = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: buildHeaders(token),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(
        `Failed to fetch file (${response.status}): ${
          bodyText || response.statusText
        }. Check the file key and your token permissions.`
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
    // Load all pages first
    await figma.loadAllPagesAsync();

    // Clone the node
    const clonedNode = node.clone();

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
    } else {
      throw new Error("No target page specified");
    }

    // Append to target page
    targetPage.appendChild(clonedNode);

    // Do NOT change the user's current page or viewport.
    // We append the cloned node to the target page but intentionally avoid
    // switching pages or changing the user's selection/viewport so the user
    // stays in their current context.

    figma.ui.postMessage({
      type: "success",
      message: `Successfully transferred "${node.name}" to page "${targetPage.name}" (no redirect)`,
    });

    figma.notify(`✓ Transferred to "${targetPage.name}" (no redirect)`, {
      timeout: 3000,
    });
  } catch (error) {
    throw error;
  }
}

async function transferToOtherFile(
  node: SceneNode,
  msg: TransferRequest & { token: string }
) {
  try {
    // For cross-file transfers, we need to use the REST API
    // First, export the node
    const clonedNode = node.clone();

    // Export as SVG for better compatibility
    let exportData: Uint8Array;
    if ("exportAsync" in clonedNode) {
      exportData = await clonedNode.exportAsync({ format: "SVG" });
    } else {
      throw new Error("Cannot export this node type");
    }

    const base64Data = figma.base64Encode(exportData);

    figma.ui.postMessage({
      type: "cross-file-ready",
      message: "Element exported. Preparing to transfer to destination file...",
      nodeData: {
        name: node.name,
        type: node.type,
        svg: base64Data,
      },
      targetFileKey: msg.fileKey,
      targetPageId: msg.pageId,
      newPageName: msg.newPageName,
    });

    // Remove the cloned node
    clonedNode.remove();
  } catch (error) {
    throw error;
  }
}

// Listen for selection changes
figma.on("selectionchange", () => {
  handleGetSelection();
});

// Initialize
handleCheckStoredToken();
