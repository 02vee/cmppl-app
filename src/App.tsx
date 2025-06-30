import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import {
  File as FileIcon, Folder as FolderIcon, Upload, Download, Edit, Trash2, Home, ChevronRight,
 Lock, Plus, X, ArrowLeft, ArrowRight, Menu, Mail
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

// ------- SUPABASE SETUP -------
const supabase = createClient(
  "https://bldsenlwhknswhpqizzg.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsZHNlbmx3aGtuc3docHFpenpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDc4MjE5NDcsImV4cCI6MjA2MzM5Nzk0N30.sh6FWF0R2UP5vzzySP4VV9MeGQsbkFR-H-XrkCijkwM"
);
const BUCKET = "documents";

//---------------------- Type Definitions ----------------------//
type TreeNode = {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
  size?: number;
  lastModified?: string;
  mimetype?: string;
  children?: TreeNode[];
};

//---------------------- Utility Functions ----------------------//

const formatFileSize = (bytes: number) => {
  if (!bytes) return "";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const SORT_OPTIONS = [
  { value: "name-asc", label: "Name (A-Z)" },
  { value: "name-desc", label: "Name (Z-A)" },
  { value: "date-desc", label: "Last Modified (Newest)" },
  { value: "date-asc", label: "Last Modified (Oldest)" },
  { value: "size-desc", label: "Size (Largest)" },
  { value: "size-asc", label: "Size (Smallest)" }
];

function getInitialSort() {
  return localStorage.getItem("adminDocsSort") || "date-desc";
}

function sanitizeName(name: string) {
  return name.replace(/[\\/]/g, "_");
}

// Utility: get the base name of a file (without extension)
function getBaseName(filename: string) {
  return filename.replace(/\.[^/.]+$/, "");
}

//---------------------- Supabase Folder/File Tree Helpers ----------------------//
async function listTree(prefix = ""): Promise<TreeNode[]> {
  let out: TreeNode[] = [];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) {
    console.error("Supabase error:", error);

    return out;
  }
  const folderPromises: Promise<TreeNode[]>[] = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.metadata && item.metadata.mimetype) {
      out.push({
        id: path,
        name: item.name,
        type: "file",
        path,
        size: item.metadata.size,
        lastModified: item.updated_at,
        mimetype: item.metadata.mimetype
      });
    } else {
      // Instead of awaiting each, push to array
      folderPromises.push(listTree(path));
    }
  }
  // Wait for all folder listings at once
  const childrenArrays = await Promise.all(folderPromises);
  for (const children of childrenArrays) {
    out = out.concat(children);
  }
  return out;
}

function buildTree(files: TreeNode[]): TreeNode[] {
  const sep = "/";
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  files.forEach(f => {
    const parts = f.path.split("/").filter(Boolean);
    let currPath = "";
    let parent: TreeNode | undefined;
    for (let i = 0; i < parts.length; ++i) {
      currPath = currPath ? currPath + sep + parts[i] : parts[i];
      let node = map.get(currPath);
      if (!node) {
        node = {
          id: currPath,
          name: parts[i],
          type: (i === parts.length - 1 ? f.type : "folder"),
          path: currPath,
          ...(i === parts.length - 1 && f.type === "file"
            ? { size: f.size, lastModified: f.lastModified, mimetype: f.mimetype }
            : {})
        };
        map.set(currPath, node);
        if (parent) {
          parent.children = parent.children || [];
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
      parent = node;
    }
  });

  // Prune .keep files from display, but folders still exist
  function pruneKeep(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .map(n => n.type === "folder" && n.children
        ? { ...n, children: pruneKeep(n.children.filter(c => c.name !== ".keep")) }
        : n
      );
  }
  const tree = pruneKeep(roots);

  // Assign lastModified to folders = max(lastModified of all descendants)
  function assignFolderDates(nodes: TreeNode[]): string | undefined {
    for (const node of nodes) {
      if (node.type === "folder" && node.children && node.children.length > 0) {
        // Recursively assign dates to children first
        const childrenDates = node.children.map(c => assignFolderDates([c])).filter(Boolean);
        node.lastModified = childrenDates.length > 0
          ? childrenDates.sort().reverse()[0] // latest
          : undefined;
      }
    }
    // Return max lastModified in this level
    const dates = nodes.map(n => n.lastModified).filter(Boolean) as string[];
    return dates.length > 0 ? dates.sort().reverse()[0] : undefined;
  }
  assignFolderDates(tree);

  // Now sort by lastModified: Newest first, folders/files mixed or folders first
  function sortRecursive(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type === "folder" && b.type !== "folder") return -1;
      if (a.type !== "folder" && b.type === "folder") return 1;
      const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return bTime - aTime;
    });
    nodes.forEach(n => { if (n.children) sortRecursive(n.children); });
  }
  sortRecursive(tree);
  return tree;
}

async function uploadFile(path: string, file: File) {
  await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
}
async function uploadFilesWithFolders(prefix: string, files: FileList | File[]) {
  for (const file of Array.from(files)) {
    let fullPath = (file as any).webkitRelativePath || file.name;
    if (prefix) fullPath = prefix + "/" + fullPath;
    await uploadFile(fullPath, file);
  }
}
async function deleteFileOrFolder(path: string, isFolder: boolean) {
  if (!isFolder) {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) alert(`Failed to delete file: ${path}\n${error.message}`);
    return;
  }
  let filesToDelete: string[] = [];
  const gatherFiles = async (prefix: string) => {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
    if (error) {
      console.error("Supabase list error:", error, "for prefix:", prefix);
      return;
    }
    if (!data) return;
    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.metadata && item.metadata.mimetype) {
        filesToDelete.push(itemPath);
      } else {
        if (item.name === ".keep") filesToDelete.push(itemPath);
        await gatherFiles(itemPath);
      }
    }
  };
  await gatherFiles(path);
  const { data: folderData } = await supabase.storage.from(BUCKET).list(path, { limit: 1000 });
  if (folderData && folderData.find(item => item.name === ".keep")) {
    filesToDelete.push(path + "/.keep");
  }
  if (filesToDelete.length === 0) return;
  const { error: delError } = await supabase.storage.from(BUCKET).remove(filesToDelete);
  if (delError) {
    alert("Some files could not be deleted: " + delError.message);
    console.error("Delete error:", delError, "Files:", filesToDelete);
  }
}
async function moveFileOrFolder(oldPath: string, newPath: string, isFolder = false) {
  if (oldPath === newPath) return;
  if (!isFolder) {
    const { data, error } = await supabase.storage.from(BUCKET).download(oldPath);
    if (!data || error) {
      alert("Failed to download file for renaming.");
      return;
    }
    await supabase.storage.from(BUCKET).remove([newPath]);
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(newPath, data, { upsert: true });
    if (uploadError) {
      alert("Failed to upload file to new name. Rename aborted.");
      return;
    }
    await supabase.storage.from(BUCKET).remove([oldPath]);
  } else {
    const { data: items, error } = await supabase.storage.from(BUCKET).list(oldPath, { limit: 1000 });
    if (error) return;
    for (const item of items || []) {
      const oldItemPath = oldPath + "/" + item.name;
      const newItemPath = newPath + "/" + item.name;
      if (item.metadata && item.metadata.mimetype) {
        const { data: fileData, error: downloadErr } = await supabase.storage.from(BUCKET).download(oldItemPath);
        if (fileData && !downloadErr) {
          await supabase.storage.from(BUCKET).remove([newItemPath]);
          const { error: uploadError } = await supabase.storage.from(BUCKET).upload(newItemPath, fileData, { upsert: true });
          if (!uploadError) {
            await supabase.storage.from(BUCKET).remove([oldItemPath]);
          }
        }
      } else {
        await moveFileOrFolder(oldItemPath, newItemPath, true);
      }
    }
    await supabase.storage.from(BUCKET).remove([oldPath]);
  }
}

//---------------------- ResponsiveNavbar ----------------------//
const ResponsiveNavbar = () => {
  const [open, setOpen] = useState(false);

  return (
    <nav className="bg-white/80 backdrop-blur shadow-lg rounded-xl mb-8 w-full">
      <div className="flex justify-between items-center p-4 md:p-6">
        <h1 className="text-2xl md:text-3xl font-extrabold text-blue-700 tracking-wide">CMPPL</h1>
        <button
          className="md:hidden"
          onClick={() => setOpen(!open)}
          aria-label="Menu"
        >
          {open ? <X className="h-7 w-7" /> : <Menu className="h-7 w-7" />}
        </button>
        <div className="hidden md:flex space-x-4">
          <Link to="/documents" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><FileIcon className="mr-2 h-5 w-5" />Documents</Link>
          <Link to="/contact" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><Mail className="mr-2 h-5 w-5" />Contact Us</Link>
          <Link to="/admin/login" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><Lock className="mr-2 h-5 w-5" />Admin</Link>
        </div>
      </div>
      {open && (
        <div className="flex flex-col px-4 pb-4 space-y-1 md:hidden">
          <Link to="/documents" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><FileIcon className="mr-2 h-5 w-5" />Documents</Link>
          <Link to="/contact" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><Mail className="mr-2 h-5 w-5" />Contact Us</Link>
          <Link to="/admin/login" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><Lock className="mr-2 h-5 w-5" />Admin</Link>
        </div>
      )}
    </nav>
  );
};

//---------------------- Home Page ----------------------//
const HomePage = () => (
  <div className="relative min-h-screen flex flex-col justify-center items-center overflow-hidden">
    {/* Decorative layered SVGs */}
    <div className="absolute inset-0 z-0">
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-400 via-blue-500 to-purple-600 opacity-95" />
      {/* Top SVG wave */}
      <svg className="absolute top-0 left-0 w-full" viewBox="0 0 1440 250" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path fill="#FFF" fillOpacity="0.13" d="M0,192L80,165.3C160,139,320,85,480,64C640,43,800,53,960,80C1120,107,1280,149,1360,170.7L1440,192L1440,0L1360,0C1280,0,1120,0,960,0C800,0,640,0,480,0C320,0,160,0,80,0L0,0Z"/>
      </svg>
      {/* Bottom SVG wave */}
      <svg className="absolute bottom-0 left-0 w-full" viewBox="0 0 1440 320" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path fill="#FFF" fillOpacity="0.19" d="M0,288L60,272C120,256,240,224,360,197.3C480,171,600,149,720,133.3C840,117,960,107,1080,122.7C1200,139,1320,181,1380,202.7L1440,224L1440,320L1380,320C1320,320,1200,320,1080,320C960,320,840,320,720,320C600,320,480,320,360,320C240,320,120,320,60,320L0,320Z"/>
      </svg>
      {/* Subtle noise overlay (optional, comment out if not wanted) */}
      <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/noise.png')] opacity-10 pointer-events-none" />
    </div>
    {/* Content */}
    <div className="relative z-10 w-full">
      <div className="max-w-4xl mx-auto">
        <ResponsiveNavbar />
        <div className="bg-white/90 rounded-3xl shadow-2xl px-8 py-12 mt-12 mb-12 flex flex-col items-center border border-blue-100">
          <img src="https://www.alccofine.com/images/alccofine-logo.png" alt="CMPPL Logo" className="w-48 mb-6 drop-shadow-xl" /> {/* You can use your own logo here */}
          <h2 className="text-3xl md:text-4xl font-extrabold mb-4 text-blue-800 text-center drop-shadow">Welcome to CMPPL</h2>
          <p className="mb-3 text-gray-700 text-lg text-center max-w-2xl">
            <span className="font-semibold">CMPPL</span> (Counto Microfine Products Pvt. Ltd.) is a joint venture company of Ambuja Cements Ltd and Alcon group Goa. It is a pioneer in the country for patented micro fine mineral additives technology. It has one of the world’s biggest dedicated manufacturing facilities of micro fine materials at Goa.
          </p>
          <p className="text-gray-600 text-center max-w-xl">
            Our platform enables secure document sharing between users and administrators.
          </p>
          <div className="mt-8 flex gap-6">
            <Link
              to="/documents"
              className="inline-flex items-center px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-lg font-semibold shadow transition"
            >
              <FileIcon className="mr-2 h-5 w-5" /> View Documents
            </Link>
            <Link
              to="/contact"
              className="inline-flex items-center px-6 py-3 rounded-xl bg-white border-2 border-blue-600 text-blue-700 font-semibold text-lg shadow hover:bg-blue-50 transition"
            >
              <Mail className="mr-2 h-5 w-5" /> Contact Us
            </Link>
          </div>
        </div>
      </div>
    </div>
  </div>
);

//---------------------- Contact Us Page ----------------------//
const ADDRESSES = [
  {
    label: "Marketing Office",
    lines: [
      "Ambuja Cements Ltd.",
      "Elegant business park,",
      "MIDC cross road B, JB Nagar, Andheri East,",
      "Mumbai",
      "Pin code: 400059",
      "Contact: +91 7030935351",
      "Email: alcofine.customercare@adani.com"
    ]
  },
  {
    label: "Factory Address",
    lines: [
      "Counto Microfine Products Pvt. Ltd.",
      "Plot No. 161-168, Pissurlem Industrial Estate",
      "Pissurlem Sattari Goa",
      "Pin code: 403530",
      "Phone: +91 832 235 2042/50",
      "Contact: +91 9923593847"
    ]
  },
  {
    label: "Registered office/ CORPORATE OFFICE:",
    lines: [
      "Counto Microfine Products Pvt. Ltd.",
      "Fourth Floor, Alcon House,",
      "Chalta No.72, P.T. Sr. No.19,",
      "Near Sai Baba Temple,",
      "Kadamba Road, Panaji-Goa,",
      "Pin code: 403006",
      "Contact: +91 832 222 0301/02",
    ]
  }
];

const ContactUsPage = () => (
  <div className="relative min-h-screen flex flex-col items-center justify-center overflow-x-hidden">
    {/* Decorative SVG Wave */}
    <div className="absolute top-0 left-0 w-full pointer-events-none z-0" style={{height: '220px', minHeight: '140px'}}>
      <svg viewBox="0 0 1440 320" className="w-full h-full">
        <path fill="#3b82f6" fillOpacity="0.23" d="M0,256L60,245.3C120,235,240,213,360,213.3C480,213,600,235,720,229.3C840,224,960,192,1080,186.7C1200,181,1320,203,1380,213.3L1440,224L1440,0L1380,0C1320,0,1200,0,1080,0C960,0,840,0,720,0C600,0,480,0,360,0C240,0,120,0,60,0L0,0Z"></path>
      </svg>
    </div>
    <div className="absolute inset-0 z-0 bg-gradient-to-br from-blue-100 via-blue-50 to-slate-200" />
    <div className="relative z-10 w-full flex flex-col items-center justify-center pt-12 pb-8">
      <h2 className="text-4xl font-extrabold text-blue-700 mb-8 drop-shadow">Contact Us</h2>
      <div className="relative w-full max-w-xl mx-auto">
        <div className="absolute left-6 top-0 h-full w-1 bg-blue-200 rounded"></div>
        <div className="flex flex-col gap-12">
          {ADDRESSES.map((addr, idx) => (
            <div key={addr.label} className="relative flex items-start gap-6">
              {/* Empty circle for visual timeline, but no number */}
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-blue-100 border-2 border-blue-300 flex items-center justify-center shadow" />
                {idx < ADDRESSES.length - 1 && (
                  <div className="flex-1 w-1 bg-blue-200 my-2" style={{ minHeight: 30 }}></div>
                )}
              </div>
              <div className="bg-white/90 rounded-2xl shadow-2xl p-6 border border-blue-100 w-full">
                <h3 className="text-lg font-bold text-blue-700 mb-2">{addr.label}</h3>
                <ul className="text-gray-600 text-sm space-y-1">
                  {addr.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
    {/* Decorative SVG at the bottom */}
    <div className="absolute bottom-0 left-0 w-full pointer-events-none z-0" style={{height: '100px', minHeight: '60px'}}>
      <svg viewBox="0 0 1440 320" className="w-full h-full">
        <path fill="#3b82f6" fillOpacity="0.17" d="M0,32L120,37.3C240,43,480,53,720,53.3C960,53,1200,43,1320,37.3L1440,32L1440,320L1320,320C1200,320,960,320,720,320C480,320,240,320,120,320L0,320Z"></path>
      </svg>
    </div>
  </div>
);

//---------------------- DocumentsPage (Supabase, public, read-only) ----------------------//
const DocumentsPage = () => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [search, setSearch] = useState<string>("");
  const [viewDoc, setViewDoc] = useState<TreeNode | null>(null);
  const [folderStack, setFolderStack] = useState<string[]>([]);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    const docs = await listTree();
    setTree(buildTree(docs));
  }

  function getCurrentChildren() {
    let node = tree;
    for (const id of folderStack) {
      const next = node.find(d => d.id === id && d.type === "folder");
      if (next && next.children) node = next.children;
      else return [];
    }
    return node;
  }

  function searchTree(nodes: TreeNode[], q: string): TreeNode[] {
    if (!q.trim()) return nodes;
    q = q.toLowerCase();
    const filterTree = (docs: TreeNode[]): TreeNode[] =>
      docs
        .map(doc => {
          if (doc.type === "folder" && doc.children) {
            const children = filterTree(doc.children);
            if (children.length > 0 || doc.name.toLowerCase().includes(q)) {
              return { ...doc, children };
            }
            return null;
          } else if (doc.name.toLowerCase().includes(q)) {
            return doc;
          }
          return null;
        })
        .filter(Boolean) as TreeNode[];
    return filterTree(nodes);
  }

  const handleFolderOpen = (doc: TreeNode) => {
    setFolderStack([...folderStack, doc.id]);
    setSearch("");
  };

  const handleUp = () => {
    setFolderStack(folderStack.slice(0, -1));
    setSearch("");
  };

  // Show both folders and files in a single vertical list
  const renderTree = (nodes: TreeNode[]) => {
    const folders = nodes.filter(doc => doc.type === "folder");
    const files = nodes.filter(doc => doc.type === "file");
    const all = [...folders, ...files];

    return (
      <ul className="divide-y divide-gray-200 mt-2">
        {all.map(doc => {
          if (doc.type === "folder") {
            return (
              <li
                key={doc.id}
                className="flex items-center gap-3 py-2 px-2 group cursor-pointer transition-all"
                onClick={() => handleFolderOpen(doc)}
                tabIndex={0}
                role="button"
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === " ") handleFolderOpen(doc);
                }}
              >
                <FolderIcon className="h-6 w-6 text-yellow-500 mr-2" />
                <span className="flex-1 font-medium text-xs break-all">{doc.name}</span>
                {doc.lastModified && <span className="text-xs text-gray-400">{new Date(doc.lastModified).toLocaleString()}</span>}
                <ChevronRight className="h-4 w-4 text-blue-500" />
              </li>
            );
          } else {
            return (
              <li
                key={doc.id}
                className="flex items-center gap-3 py-2 px-2 group cursor-pointer transition-all"
                onClick={() => setViewDoc(doc)}
                onDoubleClick={() => setViewDoc(doc)}
                tabIndex={0}
                role="button"
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === " ") setViewDoc(doc);
                }}
              >
                <FileIcon className="h-6 w-6 text-blue-500 mr-2" />
                <span className="flex-1 font-medium text-xs break-all">{doc.name}</span>
                {doc.size && <span className="text-xs text-gray-600">{formatFileSize(doc.size)}</span>}
                {doc.lastModified && <span className="text-xs text-gray-400">{new Date(doc.lastModified).toLocaleString()}</span>}
                <button
                  onClick={e => { e.stopPropagation(); handleDownload(doc); }}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                  tabIndex={-1}
                  title="Download"
                  type="button"
                >
                  <Download className="h-4 w-4" />
                </button>
              </li>
            );
          }
        })}
        {all.length === 0 && (
          <li className="text-gray-400 px-2 py-4">No documents available</li>
        )}
      </ul>
    );
  };

  async function handleDownload(doc: TreeNode) {
    const { data, error } = await supabase.storage.from("documents").download(doc.path);
    if (error || !data) {
      alert("Failed to download file.");
      return;
    }
    const url = window.URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  const docsToShow = searchTree(getCurrentChildren(), search).sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const renderDocViewer = (doc: TreeNode) => {
    const url = supabase.storage.from("documents").getPublicUrl(doc.path).data.publicUrl;
    const ext = doc.name.split('.').pop()?.toLowerCase() || "";

    // Image preview
    if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext)) {
      return <img src={url} alt={doc.name} className="max-h-[70vh] max-w-full mx-auto rounded shadow" />;
    }
    // PDF preview
    if (ext === "pdf") {
      return <iframe title={doc.name} src={url} className="w-full" style={{ minHeight: "70vh" }} />;
    }
    // Text preview
    if (["txt", "md", "csv", "json", "log"].includes(ext)) {
      return <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600">View Raw Text</a>;
    }
    // Office/OpenDocument preview via Google Docs Viewer
    if (["doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "ods", "odp"].includes(ext)) {
      const googleDocsUrl = `https://docs.google.com/gview?url=${encodeURIComponent(url)}&embedded=true`;
      return (
        <div>
          <iframe
            title={doc.name}
            src={googleDocsUrl}
            style={{ width: "100%", minHeight: "70vh", border: 0 }}
          ></iframe>
          <div className="mt-3">
            <a href={url} download={doc.name} className="text-blue-600 underline">Download {doc.name}</a>
          </div>
        </div>
      );
    }
    // Fallback for all other files
    return (
      <div>
        <p>Cannot preview this file type.</p>
        <a href={url} download={doc.name} className="text-blue-600 underline">Download {doc.name}</a>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
      <div className="max-w-6xl mx-auto">
        <Link to="/" className="inline-flex items-center text-blue-600 mb-4 hover:underline">
          <Home className="mr-1 h-5 w-5" /> Back to Home
        </Link>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
          <h2 className="text-2xl font-bold mb-4 flex items-center text-blue-700">
            <FolderIcon className="mr-2 h-6 w-6" /> Documents
          </h2>
          {/* Up button for folders */}
          {folderStack.length > 0 && (
            <button
              className="bg-gray-200 px-3 py-2 rounded-lg flex items-center gap-1 font-semibold shadow hover:bg-gray-300 transition mb-4"
              onClick={handleUp}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
          )}
          <div className="flex items-center mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search documents..."
              className="border rounded px-3 py-2 w-full md:w-1/3"
            />
          </div>
          <div className="border rounded-xl p-4 bg-gray-50/60">
            {renderTree(docsToShow)}
          </div>
        </div>
      </div>
      {viewDoc && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex items-center p-4 bg-blue-700 shadow">
            <button
              className="mr-4 text-white flex items-center gap-2 font-bold text-lg"
              onClick={() => setViewDoc(null)}
            >
              <ArrowLeft className="h-6 w-6" /> Back
            </button>
            <span className="text-white font-semibold truncate">{viewDoc.name}</span>
          </div>
          <div className="flex-1 p-0 overflow-auto flex justify-center items-center bg-black bg-opacity-5">
            <div className="w-full h-full flex items-center justify-center">
              {renderDocViewer(viewDoc)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

//---------------------- Admin Login Page ----------------------//
const AdminLogin = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username === 'cmppl' && password === 'Cmppl123') {
      localStorage.setItem('isAuthenticated', 'true');
      navigate('/admin');
    } else setError('Invalid username or password');
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white/95 rounded-2xl shadow-2xl p-8">
        <h2 className="text-2xl font-bold mb-6 text-center text-blue-700">Admin Login</h2>
        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full p-3 border-2 border-blue-100 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-400 shadow-sm transition"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border-2 border-blue-100 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-400 shadow-sm transition"
              required
            />
          </div>
          {error && <div className="text-red-500 text-sm">{error}</div>}
          <button
            type="submit"
            className="w-full bg-gradient-to-tr from-blue-600 to-blue-400 hover:from-blue-700 hover:to-blue-500 text-white py-3 px-4 rounded-lg shadow-lg font-semibold transition"
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
};

//---------------------- Admin Dashboard Page ----------------------//
const AdminDashboard = () => {
  const navigate = useNavigate();
  const handleLogout = () => {
    localStorage.removeItem('isAuthenticated');
    navigate('/');
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-extrabold text-blue-700">Admin Dashboard</h1>
          <button onClick={handleLogout} className="text-blue-700 hover:underline font-semibold">Logout</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-1 gap-8">
          <Link to="/admin/docs" className="bg-white/90 rounded-2xl shadow-xl p-8 hover:shadow-2xl hover:-translate-y-1 transition">
            <div className="flex items-center mb-2">
              <FileIcon className="h-7 w-7 text-blue-500 mr-3" />
              <h2 className="text-xl font-bold text-blue-700">Manage Documents</h2>
            </div>
            <p className="mt-2 text-gray-600">Upload and organize documents</p>
          </Link>
        </div>
      </div>
    </div>
  );
};

//---------------------- Admin Documents Page (Supabase) ----------------------//
const AdminDocumentsPage = () => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [folderStack, setFolderStack] = useState<string[]>([]);
  const [showModal, setShowModal] = useState<null | "file" | "folder" | "edit">(null);
  const [modalTarget, setModalTarget] = useState<TreeNode | null>(null);
  const [modalInput, setModalInput] = useState<string>("");
  const [modalFile, setModalFile] = useState<FileList | null>(null);
  const [search, setSearch] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewDoc, setViewDoc] = useState<TreeNode | null>(null);
  const [uploading, setUploading] = useState(false);
  const [clipboard, setClipboard] = useState<{type: "copy" | "cut", nodes: TreeNode[]} | null>(null);
  const [sort, setSort] = useState(getInitialSort());
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const dragItem = useRef<TreeNode | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const [sortBy, sortOrder] = sort.split("-") as ["name"|"date"|"size", "asc"|"desc"];

  useEffect(() => {
    localStorage.setItem("adminDocsSort", sort);
  }, [sort]);

  const refresh = useCallback(async () => {
    const docs = await listTree();
    setTree(buildTree(docs));
    setSelected(new Set());
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!showModal && mainRef.current) {
      mainRef.current.focus();
    }
  }, [showModal, folderStack]);

  // Keyboard shortcuts (cut/copy/paste/delete/rename/select all)
  const handleKeyDown = async (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (showModal) return;
    if ((e.ctrlKey || e.metaKey) && selected.size > 0) {
      if (e.key.toLowerCase() === "c") {
        setClipboard({type: "copy", nodes: Array.from(selected).map(id => findNodeById(id, tree)).filter(Boolean) as TreeNode[]});
      }
      if (e.key.toLowerCase() === "x") {
        setClipboard({type: "cut", nodes: Array.from(selected).map(id => findNodeById(id, tree)).filter(Boolean) as TreeNode[]});
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) {
      await doPaste();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const nodes = getCurrentChildren();
      setSelected(new Set(nodes.map(n => n.id)));
    }
    if (e.key === "Delete" && selected.size > 0) {
      for (const doc of Array.from(selected).map(id => findNodeById(id, tree)).filter(Boolean) as TreeNode[]) {
        await handleDelete(doc);
      }
    }
    if (e.key === "F2" && selected.size === 1) {
      const doc = findNodeById(Array.from(selected)[0], tree);
      if (doc) handleRename(doc);
    }
  };

  function findNodeById(id: string, nodes: TreeNode[]): TreeNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = findNodeById(id, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  async function doPaste() {
    if (!clipboard) return;
    setUploading(true);
    for (let node of clipboard.nodes) {
      const destPath = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + node.name;
      if (clipboard.type === "copy") {
        await copyFileOrFolder(node, destPath);
      }
      if (clipboard.type === "cut") {
        await moveFileOrFolder(node.path, destPath, node.type === "folder");
      }
    }
    if (clipboard.type === "cut") setClipboard(null);
    setUploading(false);
    await refresh();
  }

  async function copyFileOrFolder(node: TreeNode, destPath: string) {
    if (node.type === "folder") {
      const { data } = await supabase.storage.from(BUCKET).list(node.path, { limit: 1000 });
      for (const item of data || []) {
        const childPath = `${node.path}/${item.name}`;
        const childDestPath = `${destPath}/${item.name}`;
        if (item.metadata && item.metadata.mimetype) {
          const { data: fileData } = await supabase.storage.from(BUCKET).download(childPath);
          if (fileData) await supabase.storage.from(BUCKET).upload(childDestPath, fileData, { upsert: false });
        } else {
          await copyFileOrFolder({ ...node, path: childPath, name: item.name, type: "folder" }, childDestPath);
        }
      }
    } else {
      const { data } = await supabase.storage.from(BUCKET).download(node.path);
      if (data) await supabase.storage.from(BUCKET).upload(destPath, data, { upsert: false });
    }
  }

  // ---- DRAG & DROP LOGIC (fixed for nested folders) ----
  function handleDragStart(doc: TreeNode) {
    dragItem.current = doc;
  }
  async function handleCardDrop(targetDoc: TreeNode | null) {
    if (!dragItem.current) return;

    let destPrefix = getCurrentPrefix();
    if (targetDoc && targetDoc.type === "folder") {
      destPrefix = targetDoc.id;
    } else if (targetDoc && targetDoc.type === "file") {
      const parentPath = targetDoc.path.substring(0, targetDoc.path.lastIndexOf("/"));
      if (parentPath) destPrefix = parentPath;
    }
    const destPath = destPrefix ? `${destPrefix}/${dragItem.current.name}` : dragItem.current.name;

    if (dragItem.current.path === destPath) {
      dragItem.current = null;
      return;
    }
    if (dragItem.current.type === "folder" && destPath.startsWith(dragItem.current.path)) {
      dragItem.current = null;
      return;
    }
    setUploading(true);
    await moveFileOrFolder(dragItem.current.path, destPath, dragItem.current.type === "folder");
    setUploading(false);
    dragItem.current = null;
    await refresh();
  }

  const getCurrentPrefix = () => folderStack.length ? folderStack[folderStack.length - 1] : "";

  function sortDocs(nodes: TreeNode[]): TreeNode[] {
    const sorted = [...nodes].sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      let comp = 0;
      if (sortBy === 'name') {
        comp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortBy === 'size') {
        comp = (a.size || 0) - (b.size || 0);
      } else if (sortBy === 'date') {
        comp = (new Date(a.lastModified || 0).getTime()) - (new Date(b.lastModified || 0).getTime());
      }
      if (sortOrder === 'desc') comp = -comp;
      return comp;
    });
    return sorted.map(n => n.type === 'folder' && n.children
      ? { ...n, children: sortDocs(n.children) }
      : n
    );
  }

  function searchDocs(nodes: TreeNode[], q: string): TreeNode[] {
    if (!q.trim()) return nodes;
    q = q.toLowerCase();
    const filterTree = (docs: TreeNode[]): TreeNode[] =>
      docs
        .map(doc => {
          if (doc.type === "folder" && doc.children) {
            const children = filterTree(doc.children);
            if (children.length > 0 || doc.name.toLowerCase().includes(q)) {
              return { ...doc, children };
            }
            return null;
          } else if (doc.name.toLowerCase().includes(q)) {
            return doc;
          }
          return null;
        })
        .filter(Boolean) as TreeNode[];
    return filterTree(nodes);
  }

  function getCurrentChildren() {
    let node = tree;
    for (const id of folderStack) {
      const next = node.find(d => d.id === id && d.type === "folder");
      if (next && next.children) node = next.children;
      else return [];
    }
    return node;
  }
  const docsToShow = sortDocs(searchDocs(getCurrentChildren(), search));

  const renderSortDropdown = () => (
    <div className="relative">
      <button
        className="flex items-center border px-3 py-2 rounded-lg bg-white shadow hover:bg-blue-100"
        onClick={() => setSortDropdownOpen(o => !o)}
        type="button"
      >
        Sort
        <ChevronRight className={`ml-1 h-4 w-4 transition-transform ${sortDropdownOpen ? "rotate-90" : ""}`} />
      </button>
      {sortDropdownOpen && (
        <div
          className="absolute right-0 mt-2 w-56 bg-white border rounded-xl shadow-lg z-20"
          onMouseLeave={() => setSortDropdownOpen(false)}
        >
          <ul className="py-2">
            {SORT_OPTIONS.map(opt => (
              <li key={opt.value}>
                <label className="flex items-center px-4 py-2 cursor-pointer hover:bg-blue-50">
                  <input
                    type="radio"
                    name="sort"
                    value={opt.value}
                    checked={sort === opt.value}
                    onChange={() => {
                      setSort(opt.value);
                      setSortDropdownOpen(false);
                    }}
                    className="mr-2"
                  />
                  {opt.label}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  // ---- Breadcrumbs using full path ----
  let crumbs: { name: string, id: string, path: string[] }[] = [{ name: "Root", id: "root", path: [] }];
  let node = tree;
  let pathArr: string[] = [];
  for (const id of folderStack) {
    const found = node.find(d => d.id === id && d.type === "folder");
    if (found) {
      pathArr = [...pathArr, id];
      crumbs.push({ name: found.name, id: found.id, path: [...pathArr] });
      node = found.children || [];
    }
  }
  const renderBreadcrumbs = () => (
    <nav className="flex items-center mb-4">
      {crumbs.map((c, i) => (
        <span key={c.id} className="flex items-center">
          <button onClick={() => setFolderStack(c.path)} className="text-blue-600 hover:underline font-bold">{c.name}</button>
          {i < crumbs.length - 1 && <ChevronRight className="h-4 w-4 mx-1 text-gray-300" />}
        </span>
      ))}
    </nav>
  );

  // ---- Render Tree: folders and files in a single vertical list ----
  const renderTree = (nodes: TreeNode[]) => {
    const folders = nodes.filter(doc => doc.type === "folder");
    const files = nodes.filter(doc => doc.type === "file");
    const all = [...folders, ...files];

    return (
      <ul className="divide-y divide-gray-200 mt-2">
        {all.map(doc => {
          if (doc.type === "folder") {
            return (
              <li
                key={doc.id}
                className={`flex items-center gap-3 py-2 px-2 group cursor-pointer transition-all
                  ${selected.has(doc.id) ? "bg-blue-50" : ""}`}
                onClick={e => {
                  e.stopPropagation();
                  setFolderStack([...folderStack, doc.id]);
                }}
                draggable
                onDragStart={() => handleDragStart(doc)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleCardDrop(doc); }}
                tabIndex={0}
                role="button"
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === " ") setFolderStack([...folderStack, doc.id]);
                }}
              >
                <FolderIcon className="h-6 w-6 text-yellow-500 mr-2" />
                <span className="flex-1 font-medium text-xs break-all">{doc.name}</span>
                {doc.lastModified && <span className="text-xs text-gray-400">{new Date(doc.lastModified).toLocaleString()}</span>}
                <button
                  onClick={e => { e.stopPropagation(); handleRename(doc); }}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                  tabIndex={-1}
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(doc); }}
                  className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-100"
                  tabIndex={-1}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); setFolderStack([...folderStack, doc.id]); }}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                  tabIndex={-1}
                  title="Open"
                >
                  <ArrowRight className="h-4 w-4" />
                </button>
              </li>
            );
          } else {
            return (
              <li
                key={doc.id}
                className={`flex items-center gap-3 py-2 px-2 group cursor-pointer transition-all
                  ${selected.has(doc.id) ? "bg-blue-50" : ""}`}
                onClick={e => handleSelect(e, doc.id)}
                onDoubleClick={e => {
                  e.stopPropagation();
                  setViewDoc(doc);
                }}
                draggable
                onDragStart={() => handleDragStart(doc)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleCardDrop(doc); }}
                tabIndex={0}
                role="button"
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === " ") setViewDoc(doc);
                }}
              >
                <FileIcon className="h-6 w-6 text-blue-500 mr-2" />
                <span className="flex-1 font-medium text-xs break-all">{getBaseName(doc.name)}</span>
                {doc.size && <span className="text-xs text-gray-600">{formatFileSize(doc.size)}</span>}
                {doc.lastModified && <span className="text-xs text-gray-400">{new Date(doc.lastModified).toLocaleString()}</span>}
                <button
                  onClick={e => { e.stopPropagation(); setViewDoc(doc); }}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                  tabIndex={-1}
                >
                  View
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleRename(doc); }}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                  tabIndex={-1}
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(doc); }}
                  className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-100"
                  tabIndex={-1}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          }
        })}
        {all.length === 0 && (
          <li className="text-gray-400 px-2 py-4">Empty folder</li>
        )}
      </ul>
    );
  };

  const renderDocViewer = (doc: TreeNode) => {
    const url = supabase.storage.from(BUCKET).getPublicUrl(doc.path).data.publicUrl;
    const ext = doc.name.split('.').pop()?.toLowerCase() || "";
    if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext)) {
      return <img src={url} alt={doc.name} className="max-h-[70vh] max-w-full mx-auto rounded shadow" />;
    }
    if (ext === "pdf") {
      return <iframe title={doc.name} src={url} className="w-full" style={{ minHeight: "70vh" }} />;
    }
    if (["txt", "md", "csv", "json", "log"].includes(ext)) {
      return <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600">View Raw Text</a>;
    }
    return (
      <div>
        <p>Cannot preview this file type.</p>
        <a href={url} download={doc.name} className="text-blue-600 underline">Download</a>
      </div>
    );
  };

  const handleSelect = (e: React.MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected(sel => {
        const set = new Set(sel);
        set.has(id) ? set.delete(id) : set.add(id);
        return set;
      });
    } else setSelected(new Set([id]));
  };

  const handleAdd = (type: "file" | "folder") => {
    setShowModal(type);
    setModalInput("");
    setModalFile(null);
  };
  const handleRename = (doc: TreeNode) => {
    setModalTarget(doc);
    setModalInput(doc.name);
    setShowModal("edit");
  };
  const doAdd = async () => {
    setUploading(true);
    if (showModal === "folder" && modalInput.trim()) {
      const folderPath = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + sanitizeName(modalInput);
      await uploadFile(folderPath + "/.keep", new Blob([""], { type: "text/plain" }) as any as File);
      setShowModal(null);
      setModalInput("");
      await refresh();
    }
    if (showModal === "file" && modalFile) {
      for (const file of Array.from(modalFile)) {
        const path = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + sanitizeName(file.name);
        await uploadFile(path, file);
      }
      setShowModal(null);
      setModalFile(null);
      setModalInput("");
      await refresh();
    }
    setUploading(false);
  };
  const doRename = async () => {
    if (!modalTarget) return;
    const newName = modalInput.trim();
    if (!newName || newName === modalTarget.name) { setShowModal(null); return; }
    const prefix = modalTarget.path.substring(0, modalTarget.path.lastIndexOf("/"));
    const newPath = (prefix ? prefix + "/" : "") + newName + (modalTarget.type === "folder" ? "" : "");
    await moveFileOrFolder(modalTarget.path, newPath, modalTarget.type === "folder");
    setShowModal(null);
    setModalTarget(null);
    await refresh();
  };
  const handleDelete = async (doc: TreeNode) => {
    if (!window.confirm(`Delete ${doc.name}?`)) return;
    setUploading(true);
    await deleteFileOrFolder(doc.path, doc.type === "folder");
    setUploading(false);
    await refresh();
  };
  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    setUploading(true);
    await uploadFilesWithFolders(getCurrentPrefix(), e.target.files);
    setUploading(false);
    await refresh();
  };

  // --- DRAG & DROP SUPPORT: Drop anywhere on the page ---
  const handleGlobalDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setUploading(true);

    let allFiles: File[] = [];

    // Helper to recursively traverse directories
    const traverseFileTree = async (item: any, path = ""): Promise<File[]> => {
      return new Promise<File[]>((resolve) => {
        if (item.isFile) {
          item.file((file: File) => {
            Object.defineProperty(file, 'webkitRelativePath', {
              value: path + file.name,
              writable: false
            });
            resolve([file]);
          });
        } else if (item.isDirectory) {
          const dirReader = item.createReader();
          dirReader.readEntries(async (entries: any) => {
            const files = (await Promise.all(entries.map((entry: any) => traverseFileTree(entry, path + item.name + "/")))).flat();
            resolve(files);
          });
        } else {
          resolve([]);
        }
      });
    };

    if (e.dataTransfer.items && e.dataTransfer.items.length > 0 && 'webkitGetAsEntry' in e.dataTransfer.items[0]) {
      const entries: any[] = [];
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        const entry = e.dataTransfer.items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      const all = await Promise.all(entries.map(entry => traverseFileTree(entry, "")));
      allFiles = all.flat();
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      allFiles = Array.from(e.dataTransfer.files);
    }

    if (allFiles.length > 0) {
      await uploadFilesWithFolders(getCurrentPrefix(), allFiles);
    }

    setUploading(false);
    await refresh();
  };
  const handleGlobalDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // --- Main Render ---
  return (
    <div
      className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4"
      tabIndex={0}
      ref={mainRef}
      onKeyDown={handleKeyDown}
      onDrop={handleGlobalDrop}
      onDragOver={handleGlobalDragOver}
    >
      <div className="max-w-6xl mx-auto">
        <button
          className="inline-flex items-center text-blue-600 mb-4 hover:underline"
          onClick={() => window.history.back()}
        >
          <ArrowLeft className="mr-1 h-5 w-5" /> Back to Dashboard
        </button>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
          <h2 className="text-2xl font-bold mb-4 flex items-center text-blue-700"><FolderIcon className="mr-2 h-6 w-6" /> Manage Documents</h2>
          {renderBreadcrumbs()}
          <div className="flex items-center gap-3 mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search documents in this folder..."
              className="border rounded px-3 py-2 w-full md:w-1/3"
            />
            {renderSortDropdown()}
            {uploading && <span className="ml-3 text-blue-600 animate-pulse">Uploading...</span>}
          </div>
          <div className="mb-6 flex flex-wrap gap-3">
            <button className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg flex items-center gap-1 font-semibold shadow transition" onClick={() => handleAdd("folder")}><Plus className="h-4 w-4" />New Folder</button>
            <button className="bg-green-600 hover:bg-green-700 text-white py-2 px-4 rounded-lg flex items-center gap-1 font-semibold shadow transition" onClick={() => handleAdd("file")}><Plus className="h-4 w-4" />Upload File</button>
            <label className="bg-purple-600 hover:bg-purple-700 text-white py-2 px-4 rounded-lg flex items-center gap-1 font-semibold shadow transition cursor-pointer">
              <Upload className="h-4 w-4" /> Upload Folder
              <input
                type="file"
                style={{ display: "none" }}
                multiple
                // @ts-ignore
                webkitdirectory=""
                onChange={handleFolderUpload}
              />
            </label>
            {folderStack.length > 0 && (
              <button className="bg-gray-200 px-3 py-2 rounded-lg flex items-center gap-1 font-semibold shadow hover:bg-gray-300 transition" onClick={() => setFolderStack(folderStack.slice(0, -1))}><ArrowLeft className="h-4 w-4" />Back</button>
            )}
          </div>
          <div className="border rounded-xl p-4 bg-gray-50/60">
            {docsToShow.length ? renderTree(docsToShow) : <p className="text-gray-400">Empty folder</p>}
          </div>
        </div>
      </div>
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md animate-fadein">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-xl">{showModal === "edit" ? "Rename" : showModal === "file" ? "Upload File(s)" : "New Folder"}</h3>
              <button onClick={() => setShowModal(null)}><X className="h-5 w-5" /></button>
            </div>
            {showModal === "file" ? (
              <input type="file" multiple onChange={e => setModalFile(e.target.files)} className="mb-4" />
            ) : (
              <input type="text" className="w-full border-2 rounded-lg p-2 mb-4" value={modalInput} onChange={e => setModalInput(e.target.value)} placeholder="Name" />
            )}
            <div className="flex justify-end">
              <button onClick={showModal === "edit" ? doRename : doAdd} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg font-semibold shadow transition">{showModal === "edit" ? "Rename" : "Add"}</button>
            </div>
          </div>
        </div>
      )}
      {viewDoc && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex items-center p-4 bg-blue-700 shadow">
            <button
              className="mr-4 text-white flex items-center gap-2 font-bold text-lg"
              onClick={() => setViewDoc(null)}
            >
              <ArrowLeft className="h-6 w-6" /> Back
            </button>
            <span className="text-white font-semibold truncate">{getBaseName(viewDoc.name)}</span>
          </div>
          <div className="flex-1 p-0 overflow-auto flex justify-center items-center bg-black bg-opacity-5">
            <div className="w-full h-full flex items-center justify-center">
              {renderDocViewer(viewDoc)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


//---------------------- Protected Route ----------------------//
type ProtectedRouteProps = {
  children: React.ReactNode;
};
const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const isAuthenticated = localStorage.getItem('isAuthenticated') === 'true';
  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }
  return <>{children}</>;
};

//---------------------- Main App ----------------------//
const App = () => (
  <Router>
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/documents" element={<DocumentsPage />} />
      <Route path="/contact" element={<ContactUsPage />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
      <Route path="/admin/docs" element={<ProtectedRoute><AdminDocumentsPage /></ProtectedRoute>} />
    </Routes>
  </Router>
);

export default App;