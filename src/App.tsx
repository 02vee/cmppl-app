import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import {
  File as FileIcon, Folder as FolderIcon, Upload, Download, Edit, Trash2, Home, ChevronRight,
  Truck, MapPin, Lock, Plus, X, ArrowLeft, ArrowRight, RefreshCw, Menu
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

type Vehicle = {
  id: string;
  number: string;
  locations: Array<{
    lat: number;
    lng: number;
    time: string;
    address?: string;
  }>;
  deliveryLocation?: {
    lat: number;
    lng: number;
    address?: string;
  };
};

//---------------------- Utility Functions ----------------------//
const generateId = () => Math.random().toString(36).substring(2, 9);

const formatFileSize = (bytes: number) => {
  if (!bytes) return "";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

async function getAddress(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
    const json = await res.json();
    return json.display_name || `${lat}, ${lng}`;
  } catch {
    return `${lat}, ${lng}`;
  }
}
async function geocodeAddress(address: string): Promise<{lat: number, lng: number, address: string} | null> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`);
    const json = await res.json();
    if (json && json.length > 0) {
      return {
        lat: parseFloat(json[0].lat),
        lng: parseFloat(json[0].lon),
        address: json[0].display_name
      };
    }
    return null;
  } catch {
    return null;
  }
}
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  function toRad(x: number) { return x * Math.PI / 180; }
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
function estimateETA(curr: {lat: number, lng: number}, dest: {lat: number, lng: number}, speedKmh = 40) {
  const dist = haversineDistance(curr.lat, curr.lng, dest.lat, dest.lng);
  const hours = dist / speedKmh;
  if (hours < 0.01) return "Arrived";
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${mins} mins`;
  return `${Math.floor(mins/60)} hr ${mins%60} min`;
}

function sanitizeName(name: string) {
  return name.replace(/[\\/]/g, "_");
}

//---------------------- Supabase Folder/File Tree Helpers ----------------------//
async function listTree(prefix = ""): Promise<TreeNode[]> {
  let out: TreeNode[] = [];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) {
    console.error("Supabase error:", error);
    return out;
  }
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
      // Recursively get all files in the folder and add them to out
      const children = await listTree(path);
      out = out.concat(children);
    }
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
  // Sort folders before files, newest first (by lastModified, file first)
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
async function uploadFilesWithFolders(prefix: string, files: FileList) {
  for (const file of Array.from(files)) {
    let fullPath = file.webkitRelativePath || file.name;
    if (prefix) fullPath = prefix + "/" + fullPath;
    await uploadFile(fullPath, file);
  }
}
async function deleteFileOrFolder(path: string, isFolder: boolean) {
  if (!isFolder) {
    // Delete single file
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) alert(`Failed to delete file: ${path}\n${error.message}`);
    return;
  }

  // For folders: recursively gather all file paths (including .keep files)
  let filesToDelete: string[] = [];

  // Helper: gather all file paths under the given prefix (folder)
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
        // If it's a folder marker, add .keep if exists
        if (item.name === ".keep") filesToDelete.push(itemPath);
        // Recurse into subfolder
        await gatherFiles(itemPath);
      }
    }
  };

  await gatherFiles(path);

  // Also add the main folder's .keep if present (for empty folders)
  const { data: folderData } = await supabase.storage.from(BUCKET).list(path, { limit: 1000 });
  if (folderData && folderData.find(item => item.name === ".keep")) {
    filesToDelete.push(path + "/.keep");
  }

  if (filesToDelete.length === 0) {
    // Nothing to delete
    return;
  }

  // Remove all collected files
  const { error: delError } = await supabase.storage.from(BUCKET).remove(filesToDelete);
  if (delError) {
    alert("Some files could not be deleted: " + delError.message);
    console.error("Delete error:", delError, "Files:", filesToDelete);
  }
}
async function moveFileOrFolder(oldPath: string, newPath: string, isFolder = false) {
  if (oldPath === newPath) return;
  if (!isFolder) {
    // Download file from old path
    const { data, error } = await supabase.storage.from(BUCKET).download(oldPath);
    if (!data || error) {
      alert("Failed to download file for renaming.");
      return;
    }
    // Overwrite destination always
    await supabase.storage.from(BUCKET).remove([newPath]);
    // Upload to new path
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(newPath, data, { upsert: true });
    if (uploadError) {
      alert("Failed to upload file to new name. Rename aborted.");
      return;
    }
    // Always remove old
    await supabase.storage.from(BUCKET).remove([oldPath]);
  } else {
    // Folder: recursively move all children first
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
    // After all items are moved, delete the old folder itself (the empty "folder marker")
    await supabase.storage.from(BUCKET).remove([oldPath]);
  }
}

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
          <Link to="/transporter" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><Truck className="mr-2 h-5 w-5" />Transporter</Link>
          <Link to="/documents" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><FileIcon className="mr-2 h-5 w-5" />Documents</Link>
          <Link to="/admin/login" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><Lock className="mr-2 h-5 w-5" />Admin</Link>
        </div>
      </div>
      {open && (
        <div className="flex flex-col px-4 pb-4 space-y-1 md:hidden">
          <Link to="/transporter" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><Truck className="mr-2 h-5 w-5" />Transporter</Link>
          <Link to="/documents" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><FileIcon className="mr-2 h-5 w-5" />Documents</Link>
          <Link to="/admin/login" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><Lock className="mr-2 h-5 w-5" />Admin</Link>
        </div>
      )}
    </nav>
  );
};

//---------------------- Home Page ----------------------//
const HomePage = () => (
  <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
    <div className="max-w-4xl mx-auto">
      <ResponsiveNavbar />
      <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
        <h2 className="text-2xl font-bold mb-4 text-blue-700">Welcome to CMPPL</h2>
        <p className="mb-2 text-gray-700">
          <span className="font-semibold">CMPPL</span> (Counto Microfine Products Pvt. Ltd.) is a joint venture company of Ambuja Cements Ltd and Alcon group Goa. It is pioneer in the country for patented micro fine mineral additives technology. It has one of the world’s biggest dedicated manufacturing facilities of micro fine materials at Goa.
        </p>
        <p className="text-gray-600">
          Our platform enables secure document sharing and real-time vehicle tracking between transporters and administrators.
        </p>
      </div>
    </div>
  </div>
);

//---------------------- Transporter Page (localStorage vehicle tracking) ----------------------//
const TransporterPage = () => {
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [isTracking, setIsTracking] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{lat: number, lng: number, address?: string} | null>(null);
  const watchId = useRef<number | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryCoords, setDeliveryCoords] = useState<{lat: number, lng: number, address?: string} | null>(null);

  const saveLocation = async (lat: number, lng: number) => {
    const address = await getAddress(lat, lng);
    setCurrentLocation({ lat, lng, address });
    const trackedVehicles: Vehicle[] = JSON.parse(localStorage.getItem('trackedVehicles') || '[]');
    let idx = trackedVehicles.findIndex(v => v.number === vehicleNumber);
    const locationEntry = { lat, lng, time: new Date().toISOString(), address };
    if (idx === -1) {
      trackedVehicles.push({
        id: generateId(),
        number: vehicleNumber,
        locations: [locationEntry],
        deliveryLocation: deliveryCoords || undefined
      });
    } else {
      trackedVehicles[idx].locations.push(locationEntry);
      if (deliveryCoords) trackedVehicles[idx].deliveryLocation = deliveryCoords;
    }
    localStorage.setItem('trackedVehicles', JSON.stringify(trackedVehicles));
  };

  const startTracking = () => {
    if (!vehicleNumber.trim()) {
      alert("Please enter a vehicle number");
      return;
    }
    if (!deliveryCoords) {
      alert("Please set a delivery location");
      return;
    }
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser");
      return;
    }
    setIsTracking(true);
    watchId.current = navigator.geolocation.watchPosition(
      async (position) => {
        await saveLocation(position.coords.latitude, position.coords.longitude);
      },
      (error) => {
        setIsTracking(false);
        alert("Unable to get location: " + error.message);
      },
      { enableHighAccuracy: true }
    );
  };

  useEffect(() => {
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
      <div className="max-w-4xl mx-auto">
        <Link to="/" className="inline-flex items-center text-blue-600 mb-4 hover:underline">
          <Home className="mr-1 h-5 w-5" /> Back to Home
        </Link>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
          <h2 className="text-2xl font-bold mb-6 flex items-center text-blue-700">
            <Truck className="mr-3 h-7 w-7" /> Vehicle Tracking
          </h2>
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle Number</label>
              <input
                type="text"
                value={vehicleNumber}
                onChange={(e) => setVehicleNumber(e.target.value)}
                className="w-full p-3 border-2 border-blue-100 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-400 shadow-sm transition"
                placeholder="Enter vehicle number"
                required
                disabled={isTracking}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Address</label>
              <input
                type="text"
                value={deliveryAddress}
                onChange={e => setDeliveryAddress(e.target.value)}
                className="w-full p-3 border-2 border-blue-100 rounded-lg"
                placeholder="Enter delivery location address"
                required
                disabled={isTracking}
              />
              <button
                className="mt-2 px-3 py-1 bg-blue-200 rounded"
                disabled={!deliveryAddress.trim() || isTracking}
                onClick={async () => {
                  const coords = await geocodeAddress(deliveryAddress);
                  if (coords) {
                    setDeliveryCoords(coords);
                    alert('Delivery location set!');
                  } else {
                    alert('Could not find location, please try again.');
                  }
                }}
                type="button"
              >
                Set Delivery Location
              </button>
              {deliveryCoords && (
                <div className="mt-2 text-green-700 text-sm">
                  Set to: {deliveryCoords.address} (Lat: {deliveryCoords.lat.toFixed(4)}, Lng: {deliveryCoords.lng.toFixed(4)})
                </div>
              )}
            </div>
            <button
              onClick={startTracking}
              disabled={isTracking}
              className={`w-full py-3 px-4 rounded-lg font-semibold flex items-center justify-center transition ${
                isTracking ? 'bg-gray-300 text-gray-500' : 'bg-gradient-to-tr from-blue-600 to-blue-400 hover:from-blue-700 hover:to-blue-500 text-white shadow-lg'
              }`}
            >
              <MapPin className="mr-2 h-5 w-5" />
              {isTracking ? 'Tracking...' : 'Start Tracking'}
            </button>
            {isTracking && currentLocation && deliveryCoords && (
              <div className="p-4 bg-gradient-to-tr from-green-50 to-green-100 text-green-900 rounded-lg shadow-inner border border-green-200 animate-fadein">
                <p className="font-semibold mb-1">Tracking active for <span className="text-blue-800">{vehicleNumber}</span></p>
                <p className="mb-1">
                  <span className="font-medium text-green-800">Current Address:</span><br />
                  <span className="text-green-900">{currentLocation.address}</span>
                </p>
                <p className="mb-1">
                  <span className="font-medium text-blue-800">Delivery Location:</span><br />
                  <span className="text-green-900">{deliveryCoords.address}</span>
                </p>
                <p className="mb-2 text-blue-900 font-mono text-sm">
                  ETA: {estimateETA(currentLocation, deliveryCoords)}
                </p>
                <p className="mb-2 text-gray-700 font-mono text-sm">
                  Lat: {currentLocation.lat.toFixed(4)}, Lng: {currentLocation.lng.toFixed(4)}
                </p>
                <p className="text-xs text-gray-500">This will update in real time. You can close this window.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

//---------------------- DocumentsPage (Supabase, public, read-only) ----------------------//
const DocumentsPage = () => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [search, setSearch] = useState<string>("");
  const [viewDoc, setViewDoc] = useState<TreeNode | null>(null);
  const [folderStack, setFolderStack] = useState<string[]>([]); // <-- Track folder path

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    const docs = await listTree();
    setTree(buildTree(docs));
  }

  // Get children of current folder
  function getCurrentChildren() {
    let node = tree;
    for (const id of folderStack) {
      const next = node.find(d => d.id === id && d.type === "folder");
      if (next && next.children) node = next.children;
      else return [];
    }
    return node;
  }

  // Search/filter
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

  // When a folder is clicked, go deeper
  const handleFolderOpen = (doc: TreeNode) => {
    setFolderStack([...folderStack, doc.id]);
    setSearch(""); // optional: clear search on folder change
  };

  // "Up" button: go to parent folder
  const handleUp = () => {
    setFolderStack(folderStack.slice(0, -1));
    setSearch(""); // optional
  };

  // Render tree for current folder only
  const renderTree = (nodes: TreeNode[]) => (
    <div className="flex flex-wrap gap-4">
      {nodes.map(doc => (
        <div
          key={doc.id}
          className="flex flex-col w-60 min-h-[110px] bg-white rounded-xl shadow border p-3 relative group cursor-pointer transition-all"
        >
          <div className="flex items-center mb-2">
            {doc.type === "folder"
              ? <FolderIcon className="h-6 w-6 text-yellow-500 mr-2" />
              : <FileIcon className="h-6 w-6 text-blue-500 mr-2" />}
            <span className="font-semibold truncate">{doc.name}</span>
          </div>
          <div className="text-xs flex-1">
            {doc.type === "file" && doc.size && <span className="block text-gray-600">{formatFileSize(doc.size)}</span>}
            {doc.lastModified && <span className="block text-gray-400">{new Date(doc.lastModified).toLocaleString()}</span>}
          </div>
          <div className="flex gap-1 mt-2">
            {doc.type === "file" && (
              <>
                <button
                  onClick={() => handleDownload(doc)}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                  tabIndex={-1}
                  title="Download"
                  type="button"
                >
                  <Download className="h-4 w-4" />
                </button>
                <button onClick={() => setViewDoc(doc)} className="text-green-600 hover:text-green-800 p-1 rounded hover:bg-green-100">
                  View
                </button>
              </>
            )}
            {doc.type === "folder" && (
              <button className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                onClick={() => handleFolderOpen(doc)}>
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  async function handleDownload(doc: TreeNode) {
    const { data, error } = await supabase.storage.from(BUCKET).download(doc.path);
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

  const docsToShow = searchTree(getCurrentChildren(), search);

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
            {docsToShow.length ? renderTree(docsToShow) : <p className="text-gray-400">No documents available</p>}
          </div>
        </div>
      </div>
      {viewDoc && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-2xl animate-fadein overflow-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-xl">{viewDoc.name}</h3>
              <button onClick={() => setViewDoc(null)}><X className="h-5 w-5" /></button>
            </div>
            <div>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <Link to="/admin/track" className="bg-white/90 rounded-2xl shadow-xl p-8 hover:shadow-2xl hover:-translate-y-1 transition">
            <div className="flex items-center mb-2">
              <MapPin className="h-7 w-7 text-blue-500 mr-3" />
              <h2 className="text-xl font-bold text-blue-700">Track Vehicles</h2>
            </div>
            <p className="mt-2 text-gray-600">View and manage tracked vehicles</p>
          </Link>
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

//---------------------- Admin Track Page ----------------------//
const AdminTrackPage = () => {
  const [trackedVehicles, setTrackedVehicles] = useState<Vehicle[]>([]);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const vehicles = JSON.parse(localStorage.getItem('trackedVehicles') || '[]');
    setTrackedVehicles(vehicles);
    const interval = setInterval(() => {
      const vehicles = JSON.parse(localStorage.getItem('trackedVehicles') || '[]');
      setTrackedVehicles(vehicles);
    }, 3000);
    return () => clearInterval(interval);
  }, []);
  const handleRefresh = () => {
    const vehicles = JSON.parse(localStorage.getItem('trackedVehicles') || '[]');
    setTrackedVehicles(vehicles);
  };
  const handleDelete = (id: string) => {
    if (window.confirm("Are you sure you want to delete this vehicle from tracking?")) {
      const vehicles = trackedVehicles.filter(vehicle => vehicle.id !== id);
      setTrackedVehicles(vehicles);
      localStorage.setItem('trackedVehicles', JSON.stringify(vehicles));
    }
  };
  const filteredVehicles = trackedVehicles.filter(vehicle =>
    vehicle.number.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
      <div className="max-w-6xl mx-auto">
        <Link to="/admin" className="inline-flex items-center text-blue-600 mb-4 hover:underline">
          <Home className="mr-1 h-5 w-5" /> Back to Dashboard
        </Link>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
            <h2 className="text-2xl font-bold flex items-center text-blue-700">
              <MapPin className="mr-3 h-7 w-7" /> Vehicle Tracking
            </h2>
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search vehicle number"
                className="border rounded px-3 py-2"
              />
              <button onClick={handleRefresh} className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded flex items-center">
                <RefreshCw className="h-4 w-4 mr-1" /> Refresh
              </button>
            </div>
          </div>
          {filteredVehicles.length > 0 ? (
            <div className="space-y-6">
              {filteredVehicles.map(vehicle => {
                const latest = vehicle.locations && vehicle.locations.length > 0 ? vehicle.locations[vehicle.locations.length - 1] : null;
                return (
                  <div key={vehicle.id} className="border rounded-xl p-6 bg-gradient-to-br from-blue-50 to-gray-50 shadow-md flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-blue-800 mb-2"><span className="text-gray-700">Vehicle:</span> {vehicle.number}</h3>
                      {latest && (
                        <div className="mt-1">
                          <p className="font-medium text-blue-700 mb-1">Latest Location:</p>
                          <p>
                            {latest.address ? (
                              <>
                                <span className="block text-gray-800 font-semibold">{latest.address}</span>
                                <span className="block text-gray-700 text-xs font-mono">Lat: {latest.lat.toFixed(4)}, Lng: {latest.lng.toFixed(4)}</span>
                              </>
                            ) : (
                              <>
                                <span className="block text-gray-600 font-mono">Lat: {latest.lat.toFixed(4)}, Lng: {latest.lng.toFixed(4)}</span>
                              </>
                            )}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            Last updated: {new Date(latest.time).toLocaleString()}
                          </p>
                        </div>
                      )}
                      {vehicle.deliveryLocation && (
                        <p className="mt-2">
                          <span className="font-medium text-blue-800">Delivery Location: </span>
                          <span className="text-blue-700">{vehicle.deliveryLocation.address} (Lat: {vehicle.deliveryLocation.lat.toFixed(4)}, Lng: {vehicle.deliveryLocation.lng.toFixed(4)})</span>
                        </p>
                      )}
                      {latest && vehicle.deliveryLocation && (
                        <p className="font-medium text-green-700">
                          ETA: {estimateETA(latest, vehicle.deliveryLocation)}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-row gap-2">
                      <button
                        onClick={() => handleDelete(vehicle.id)}
                        className="bg-red-500 hover:bg-red-600 text-white px-3 py-2 rounded flex items-center"
                      >
                        <Trash2 className="h-4 w-4 mr-1" /> Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-gray-400">No vehicles being tracked</p>
          )}
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
  const [modalFile, setModalFile] = useState<File | null>(null);
  const [search, setSearch] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewDoc, setViewDoc] = useState<TreeNode | null>(null);
  const [uploading, setUploading] = useState(false);
  const [clipboard, setClipboard] = useState<{type: "copy" | "cut", nodes: TreeNode[]} | null>(null);
  const dragItem = useRef<TreeNode | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const docs = await listTree();
    setTree(buildTree(docs));
    setSelected(new Set());
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Focus main container after modal closes or folderStack changes
  useEffect(() => {
    if (!showModal && mainRef.current) {
      mainRef.current.focus();
    }
  }, [showModal, folderStack]);

  // Keyboard shortcuts on main container
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

  function handleDragStart(doc: TreeNode) {
    dragItem.current = doc;
  }
  async function handleDrop(targetDoc: TreeNode | null) {
    if (!dragItem.current) return;
    let destPrefix = getCurrentPrefix();
    if (targetDoc && targetDoc.type === "folder") {
      destPrefix = targetDoc.path;
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

  let crumbs: { name: string, id: string, path: string[] }[] = [{ name: "Root", id: "root", path: [] }];
  let node = tree;
  let path: string[] = [];
  for (const id of folderStack) {
    const found = node.find(d => d.name === id && d.type === "folder");
    if (found) {
      path = [...path, id];
      crumbs.push({ name: found.name, id: found.id, path: [...path] });
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

  const getCurrentPrefix = () => folderStack.join("/");

  const renderTree = (nodes: TreeNode[]) => (
    <div className="flex flex-wrap gap-4">
      {nodes.map(doc => (
        <div
          key={doc.id}
          className={`flex flex-col w-60 min-h-[110px] bg-white rounded-xl shadow border p-3 relative group cursor-pointer transition-all
            ${selected.has(doc.id) ? "ring-2 ring-blue-400" : ""}`}
          onClick={e => handleSelect(e, doc.id)}
          draggable
          onDragStart={() => handleDragStart(doc)}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handleDrop(doc); }}
        >
          <div className="flex items-center mb-2">
            {doc.type === "folder"
              ? <FolderIcon className="h-6 w-6 text-yellow-500 mr-2" />
              : <FileIcon className="h-6 w-6 text-blue-500 mr-2" />}
            <span className="font-semibold truncate">{doc.name}</span>
          </div>
          <div className="text-xs flex-1">
            {doc.type === "file" && doc.size && <span className="block text-gray-600">{formatFileSize(doc.size)}</span>}
            {doc.lastModified && <span className="block text-gray-400">{new Date(doc.lastModified).toLocaleString()}</span>}
          </div>
          <div className="flex gap-1 mt-2">
            {doc.type === "file" && (
              <>
                <button onClick={e => { e.stopPropagation(); setViewDoc(doc); }} className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100" tabIndex={-1}>View</button>
              </>
            )}
            <button onClick={e => { e.stopPropagation(); handleRename(doc); }} className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100" tabIndex={-1}><Edit className="h-4 w-4" /></button>
            <button onClick={e => { e.stopPropagation(); handleDelete(doc); }} className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-100" tabIndex={-1}><Trash2 className="h-4 w-4" /></button>
            {doc.type === "folder" && (
              <button onClick={e => { e.stopPropagation(); setFolderStack([...folderStack, doc.name]); }} className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100" tabIndex={-1}><ArrowRight className="h-4 w-4" /></button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

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
      const folderPath = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + modalInput;
      await uploadFile(folderPath + "/.keep", new Blob([""], { type: "text/plain" }) as any as File);
      setShowModal(null);
      setModalInput("");
      await refresh();
    }
    if (showModal === "file" && modalFile) {
      const path = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + modalFile.name;
      await uploadFile(path, modalFile);
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

  function getCurrentChildren() {
    let node = tree;
    for (const id of folderStack) {
      const next = node.find(d => d.name === id && d.type === "folder");
      if (next && next.children) node = next.children;
      else return [];
    }
    return node;
  }
  const docsToShow = searchDocs(getCurrentChildren(), search);

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4"
      tabIndex={0}
      ref={mainRef}
      onKeyDown={handleKeyDown}
    >
      <div className="max-w-6xl mx-auto">
        <Link to="/admin" className="inline-flex items-center text-blue-600 mb-4 hover:underline">
          <span className="mr-1">
            <svg className="h-5 w-5 inline" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7m-9 2v8a2 2 0 002 2h4a2 2 0 002-2v-8m-6 0H5.414a2 2 0 00-1.414.586l-.293.293a2 2 0 000 2.828l.293.293A2 2 0 005.414 15H6"></path>
            </svg>
          </span>
          Back to Dashboard
        </Link>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
          <h2 className="text-2xl font-bold mb-4 flex items-center text-blue-700"><FolderIcon className="mr-2 h-6 w-6" /> Manage Documents</h2>
          {renderBreadcrumbs()}
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
          <div className="flex items-center mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search documents in this folder..."
              className="border rounded px-3 py-2 w-full md:w-1/3"
            />
            {uploading && <span className="ml-3 text-blue-600 animate-pulse">Uploading...</span>}
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
              <h3 className="font-bold text-xl">{showModal === "edit" ? "Rename" : showModal === "file" ? "Upload File" : "New Folder"}</h3>
              <button onClick={() => setShowModal(null)}><X className="h-5 w-5" /></button>
            </div>
            {showModal === "file" ? (
              <input type="file" onChange={e => setModalFile(e.target.files?.[0] || null)} className="mb-4" />
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
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-2xl animate-fadein overflow-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-xl">{viewDoc.name}</h3>
              <button onClick={() => setViewDoc(null)}><X className="h-5 w-5" /></button>
            </div>
            <div>
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
      <Route path="/transporter" element={<TransporterPage />} />
      <Route path="/documents" element={<DocumentsPage />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
      <Route path="/admin/track" element={<ProtectedRoute><AdminTrackPage /></ProtectedRoute>} />
      <Route path="/admin/docs" element={<ProtectedRoute><AdminDocumentsPage /></ProtectedRoute>} />
    </Routes>
  </Router>
);

export default App;