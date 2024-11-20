import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import iwanthue from "iwanthue";
// import EdgeCurveProgram from "@sigma/edge-curve";
import type {Coordinates, EdgeDisplayData, NodeDisplayData} from "sigma/types";

// import { createNodeImageProgram } from "@sigma/node-image";
// import ForceSupervisor from "graphology-layout-force/worker";

import {getPrefixes, compressUri, queryEndpoint, SparqlResultBindings} from "./utils";

const voidQuery = `PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX sh:<http://www.w3.org/ns/shacl#>
PREFIX sd:<http://www.w3.org/ns/sparql-service-description#>
PREFIX void:<http://rdfs.org/ns/void#>
PREFIX void-ext:<http://ldf.fi/void-ext#>
SELECT DISTINCT ?subjectClass ?prop ?objectClass ?objectDatatype ?triples
?objectClassTopParent ?objectClassTopParentLabel ?subjectClassTopParent ?subjectClassTopParentLabel
?subjectClassLabel ?objectClassLabel ?subjectClassComment ?objectClassComment
WHERE {
  {
    SELECT * WHERE {
      {
        ?s sd:graph ?graph .
        ?graph void:classPartition ?cp .
        ?cp void:class ?subjectClass ;
          void:propertyPartition ?pp .
        OPTIONAL {?subjectClass rdfs:label ?subjectClassLabel }
        OPTIONAL {?subjectClass rdfs:comment ?subjectClassComment }
        OPTIONAL {
          ?subjectClass rdfs:subClassOf* ?subjectClassTopParent .
          OPTIONAL {?subjectClassTopParent rdfs:label ?subjectClassTopParentLabel}
          FILTER(isIRI(?subjectClassTopParent) && ?subjectClassTopParent != owl:Thing && ?subjectClassTopParent != owl:Class)
          MINUS {
            ?subjectClassTopParent rdfs:subClassOf ?intermediateParent .
            FILTER(?intermediateParent != owl:Thing && ?intermediateParent != owl:Class)
          }
        }

        ?pp void:property ?prop ;
          void:triples ?triples .
        OPTIONAL {
          {
            ?pp  void:classPartition [ void:class ?objectClass ] .
            OPTIONAL {?objectClass rdfs:label ?objectClassLabel }
            OPTIONAL {?objectClass rdfs:comment ?objectClassComment }
            OPTIONAL {
              ?objectClass rdfs:subClassOf* ?objectClassTopParent .
              OPTIONAL {?objectClassTopParent rdfs:label ?objectClassTopParentLabel}
              FILTER(isIRI(?objectClassTopParent) && ?objectClassTopParent != owl:Thing && ?objectClassTopParent != owl:Class)
              MINUS {
                ?objectClassTopParent rdfs:subClassOf ?intermediateParent .
                FILTER(?intermediateParent != owl:Thing && ?intermediateParent != owl:Class)
              }
            }
          } UNION {
            ?pp void-ext:datatypePartition [ void-ext:datatype ?objectDatatype ] .
          }
        }
      } UNION {
        ?linkset void:subjectsTarget [ void:class ?subjectClass ] ;
          void:linkPredicate ?prop ;
          void:objectsTarget [ void:class ?objectClass ] .
      }

    }
  }
} ORDER BY ?subjectClass ?objectClass ?objectDatatype ?graph ?triples`;

type Cluster = {
  label: string;
  x?: number;
  y?: number;
  color?: string;
  positions: {x: number; y: number}[];
};

const metadataNamespaces = [
  "http://www.w3.org/ns/shacl#",
  "http://www.w3.org/2002/07/owl#",
  "http://www.w3.org/2000/01/rdf-schema#",
  "http://www.w3.org/ns/sparql-service-description#",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://rdfs.org/ns/void#",
  "http://purl.org/query/voidext#",
  "http://purl.org/query/bioquery#",
];

function isMetadataNode(node: string) {
  if (!node) return false;
  if (node === "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement") return false;
  return metadataNamespaces.some(namespace => node.startsWith(namespace));
}

/**
 * Custom element to create a SPARQL network overview for a given endpoint classes and predicates
 * @example <sparql-metamap endpoint="https://sparql.uniprot.org/sparql/"></sparql-metamap>
 */
export class SparqlMetamap extends HTMLElement {
  endpoints: {[key: string]: {label?: string; description?: string; graphs?: string[]; void?: SparqlResultBindings[]}} =
    {};
  // meta: EndpointsMetadata;
  // void: {[key: string]: SparqlResultBindings[]} = {};
  prefixes: {[key: string]: string} = {};
  showMetadata: boolean = false;

  hoveredNode?: string;
  searchQuery: string = "";
  // State derived from query:
  selectedNode?: string;
  suggestions?: Set<string>;
  // State derived from hovered node:
  hoveredNeighbors?: Set<string>;

  predicatesCount: {[key: string]: number} = {};
  hidePredicates: Set<string> = new Set();

  clusters: {[key: string]: Cluster} = {};

  graph: Graph;
  renderer: Sigma | undefined;
  // https://github.com/jacomyal/sigma.js/issues/197

  constructor() {
    super();
    const endpointList = (this.getAttribute("endpoints") || "").split(",");
    // this.meta = this.loadMetaFromLocalStorage();
    // console.log("Loaded metadata from localStorage", this.meta);
    endpointList.forEach(endpoint => {
      endpoint = endpoint.trim();
      this.endpoints[endpoint] = {};
    });
    if (Object.keys(this.endpoints).length === 0)
      throw new Error("No endpoint provided. Please use the 'endpoints' attribute to specify the SPARQL endpoint URL.");

    const style = document.createElement("style");
    style.textContent = `
      html, body {
        font: 10pt arial;
      }
      #sparql-metamap {
        height: 100%;
      }
      #metamap-predicate-sidebar {
        float: left;
        width: fit-content;
        max-width: 300px;
        padding-right: 0.5em;
        overflow-y: auto;
        height: 100%;
      }
      #metamap-predicate-sidebar p, h3, h5 {
        margin: .5em 0;
      }
      #network-container {
        width: 100%;
        float: right;
        height: 100%;
        border: 1px solid lightgray;
      }
      .clusterLabel {
        // position: absolute;
        // transform: translate(-50%, -50%);
        // font-size: 1.8rem;
        font-family: sans-serif;
        font-variant: small-caps;
        font-weight: 400;
        text-shadow: 2px 2px 1px white, -2px -2px 1px white, -2px 2px 1px white, 2px -2px 1px white;
      }
      #metamap-predicate-sidebar a {
        text-decoration: none;
      }
      #sparql-metamap code {
        font-family: 'Fira Code', monospace;
        font-size: 0.95rem;
        border-radius: 6px;
        padding: 0.2em 0.4em;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
        border: 1px solid #e0e0e0;
        display: inline-block;
        word-wrap: break-word;
      }
		`;
    const container = document.createElement("div");
    container.id = "sparql-metamap";
    container.style.display = "flex";
    container.className = "container";
    container.style.height = "100%";
    container.innerHTML = `
      <div id="metamap-predicate-sidebar" style="display: flex; flex-direction: column;">
        <input type="search" id="search-input" list="suggestions" placeholder="Search classes...">
        <datalist id="suggestions"></datalist>
        <div style="text-align: center; margin-top: .5em;">
          <span>Filter predicates</span>
        </div>
        <div style="display: flex; justify-content: space-evenly; gap: .5em; margin: .5em 0;">
          <button id="metamap-show-all">Show all</button>
          <button id="metamap-hide-all">Hide all</button>
          <button id="metamap-show-meta">Show metadata</button>
        </div>
        <div id="metamap-predicates-list" style="flex: 1; overflow-y: auto;"></div>
        <div id="metamap-edge-info" style="margin-top: 1em; overflow-y: auto;"></div>
        <div id="metamap-node-info" style="margin-top: 1em; overflow-y: auto;"></div>
      </div>
      <div id="network-container" style="flex: 1; position: relative;"></div>
    `;
    this.appendChild(style);
    this.appendChild(container);

    const showAllButton = this.querySelector("#metamap-show-all") as HTMLButtonElement;
    showAllButton.addEventListener("click", () => {
      const checkboxes = this.querySelectorAll("#metamap-predicates-list input[type='checkbox']");
      checkboxes.forEach(checkbox => {
        (checkbox as HTMLInputElement).checked = true;
      });
      this.hidePredicates.clear();
      this.renderer?.refresh({skipIndexation: true});
    });
    const hideAllButton = this.querySelector("#metamap-hide-all") as HTMLButtonElement;
    hideAllButton.addEventListener("click", () => {
      const checkboxes = this.querySelectorAll("#metamap-predicates-list input[type='checkbox']");
      checkboxes.forEach(checkbox => {
        (checkbox as HTMLInputElement).checked = false;
      });
      this.hidePredicates = new Set(Object.keys(this.predicatesCount));
      this.renderer?.refresh({skipIndexation: true});
    });
    const showMetaButton = this.querySelector("#metamap-show-meta") as HTMLButtonElement;
    showMetaButton.addEventListener("click", async () => {
      this.showMetadata = !this.showMetadata;
      if (this.showMetadata) showMetaButton.textContent = "Hide metadata";
      else showMetaButton.textContent = "Show metadata";
      await this.initGraph();
    });

    // const palette = iwanthue(Object.keys(countryClusters).length, { seed: "eurSISCountryClusters" });

    this.graph = new Graph({multi: true});
  }

  async connectedCallback() {
    await Promise.all(Object.keys(this.endpoints).map(endpoint => this.fetchEndpointMetadata(endpoint)));
    await this.initGraph();
  }

  async initGraph() {
    // Reinitialize the graph
    this.renderer?.kill();
    this.graph = new Graph({multi: true});
    this.predicatesCount = {};
    this.clusters = {};

    for (const [endpoint, info] of Object.entries(this.endpoints)) {
      if (!info.void) continue;
      for (const row of info.void) {
        // const count = parseInt(row.triples.value);
        if (!this.showMetadata && (isMetadataNode(row.subjectClass.value) || isMetadataNode(row.objectClass?.value)))
          continue;
        const count = 10;

        // Get the cluster for the subject node
        const subjCluster = isMetadataNode(row.subjectClass.value)
          ? "Endpoint Metadata"
          : row.subjectClassTopParentLabel
            ? row.subjectClassTopParentLabel.value
            : row.subjectClassTopParent
              ? this.getCurie(row.subjectClassTopParent.value)
              : row.subjectClass.value.includes("Citation") // quick hack to cluster citations in uniprot
                ? "Citation"
                : "Other";
        // Add subject node
        const subjUri = row.subjectClass.value;
        const subjCurie = this.getCurie(subjUri);
        if (!this.graph.hasNode(subjUri)) {
          this.graph.addNode(subjUri, {
            label: subjCurie,
            size: count,
            cluster: subjCluster,
            endpoint: endpoint,
            datatypes: [],
          });
          if (row.subjectClassLabel)
            this.graph.updateNodeAttribute(subjUri, "displayLabel", () => row.subjectClassLabel.value);
          if (row.subjectClassComment)
            this.graph.updateNodeAttribute(subjUri, "comment", () => row.subjectClassComment.value);
        }

        // Handle when the object is a datatype (string, integer, etc)
        if (row.objectDatatype) {
          this.graph.updateNodeAttribute(subjUri, "datatypes", datatypes => {
            datatypes.push({
              predCurie: this.getCurie(row.prop.value),
              predUri: row.prop.value,
              datatypeCurie: this.getCurie(row.objectDatatype.value),
              datatypeUri: row.objectDatatype.value,
              count: parseInt(row.triples.value),
            });
            return datatypes;
          });
        }

        // Handle when the object is a class
        if (row.objectClass && !row.objectDatatype) {
          // Get the cluster for the object node
          const objCluster = isMetadataNode(row.objectClass.value)
            ? "Endpoint Metadata"
            : row.objectClassTopParentLabel
              ? row.objectClassTopParentLabel.value
              : row.objectClassTopParent
                ? this.getCurie(row.objectClassTopParent.value)
                : row.objectClass.value.includes("Citation") // quick hack to cluster citations in uniprot
                  ? "Citation"
                  : "Other";
          // Add object node
          const objUri = row.objectClass.value;
          if (!this.graph.hasNode(objUri)) {
            const objCurie = this.getCurie(objUri);
            this.graph.addNode(objUri, {
              label: objCurie,
              size: count,
              cluster: objCluster,
              endpoint: endpoint,
              datatypes: [],
            });
            if (row.objectClassLabel)
              this.graph.updateNodeAttribute(objUri, "displayLabel", () => row.objectClassLabel.value);
            if (row.objectClassComment)
              this.graph.updateNodeAttribute(objUri, "comment", () => row.objectClassComment.value);
          }
          // Add edge
          const predCurie = this.getCurie(row.prop.value);
          if (!this.predicatesCount[predCurie]) this.predicatesCount[predCurie] = 1;
          else this.predicatesCount[predCurie] += 1;
          this.graph.addEdge(subjUri, objUri, {
            label: predCurie,
            size: 2,
            // size: count,
            type: "arrow",
          });
        }
      }
    }

    this.graph.forEachNode((_node, atts) => {
      if (!this.clusters[atts.cluster]) this.clusters[atts.cluster] = {label: atts.cluster, positions: []};
    });
    // create and assign one color by cluster
    const palette = iwanthue(Object.keys(this.clusters).length, {seed: "topClassesClusters"});
    for (const cluster in this.clusters) {
      this.clusters[cluster].color = palette.pop();
    }

    // We need to manually set some x/y coordinates for the nodes
    // this.graph.nodes().forEach((node, i) => {
    //   const angle = (i * 2 * Math.PI) / this.graph.order;
    //   this.graph.setNodeAttribute(node, "x", 100 * Math.cos(angle));
    //   this.graph.setNodeAttribute(node, "y", 100 * Math.sin(angle));
    //   this.graph.setNodeAttribute(node, "color", 100 * Math.sin(angle));
    // });
    let i = 1;
    this.graph.forEachNode((node, atts) => {
      const angle = (i * 2 * Math.PI) / this.graph.order;
      i++;
      atts.x = 100 * Math.cos(angle);
      atts.y = 100 * Math.sin(angle);
      // node color depends on the cluster it belongs to
      atts.color = this.clusters[atts.cluster].color;
      // node size depends on its degree (number of connected edges)
      // atts.size = Math.sqrt(this.graph.degree(node)) / 2;
      this.clusters[atts.cluster].positions.push({x: atts.x, y: atts.y});
    });
    // Calculate the cluster's nodes barycenter to use this as cluster label position
    for (const c in this.clusters) {
      this.clusters[c].x =
        this.clusters[c].positions.reduce((acc, p) => acc + p.x, 0) / this.clusters[c].positions.length;
      this.clusters[c].y =
        this.clusters[c].positions.reduce((acc, p) => acc + p.y, 0) / this.clusters[c].positions.length;
    }
    console.log("clusters", this.clusters);

    const container = this.querySelector("#network-container") as HTMLElement;
    this.renderer = new Sigma(this.graph, container, {
      renderEdgeLabels: true,
      enableEdgeEvents: true,
      // edgeProgramClasses: {
      //   curved: EdgeCurveProgram,
      // },
    });
    const inferredLayoutSettings = forceAtlas2.inferSettings(this.graph);
    console.log("inferredLayoutSettings", inferredLayoutSettings);
    const layout = new FA2Layout(this.graph, {
      settings: {
        ...inferredLayoutSettings,
        gravity: 4,
        // strongGravityMode: true,
      },
    });
    layout.start();

    // Bind search input interactions:
    const searchInput = this.querySelector("#search-input") as HTMLInputElement;
    searchInput.addEventListener("input", () => {
      this.setSearchQuery(searchInput.value || "");
    });
    // searchInput.addEventListener("blur", () => {
    //   this.setSearchQuery("");
    // });
    // Bind graph interactions:
    this.renderer.on("enterNode", ({node}) => {
      this.setHoveredNode(node);
    });
    this.renderer.on("leaveNode", () => {
      this.setHoveredNode(undefined);
    });
    // TODO: highlight node on click
    this.renderer.on("clickNode", ({node}) => {
      this.displaySelectedNodeInfo(node);
    });
    this.renderer.on("clickStage", () => {
      this.displaySelectedNodeInfo(undefined);
    });
    this.renderer.on("enterEdge", ({edge}) => {
      console.log("enterEdge", edge);
      this.displayEdgeInfo(edge);
      // this.displaySelectedNodeInfo(undefined);
    });
    this.renderer.on("leaveEdge", () => {
      this.displayEdgeInfo(undefined);
      // this.displaySelectedNodeInfo(undefined);
    });

    // Render nodes accordingly to the internal state
    this.renderer.setSetting("nodeReducer", (node, data) => {
      const res: Partial<NodeDisplayData> = {...data};
      // If there is a hovered node, all non-neighbor nodes are greyed
      if (this.hoveredNeighbors && !this.hoveredNeighbors.has(node) && this.hoveredNode !== node) {
        res.label = "";
        res.color = "#f6f6f6";
      }
      // If a node is selected, it is highlighted
      if (this.selectedNode === node) {
        res.highlighted = true;
      } else if (this.suggestions) {
        // If there is query, all non-matching nodes are greyed
        if (this.suggestions.has(node)) {
          res.forceLabel = true;
        } else {
          res.label = "";
          res.color = "#f6f6f6";
        }
      }
      return res;
    });

    // Render edges accordingly to the internal state
    this.renderer.setSetting("edgeReducer", (edge, data) => {
      const res: Partial<EdgeDisplayData> = {...data};
      // If a node is selected, the edge is hidden if it is not connected to the node
      if (this.selectedNode && !this.graph.hasExtremity(edge, this.selectedNode)) {
        res.hidden = true;
      }
      // If a node is hovered, the edge is hidden if it is not connected to the node
      if (this.hoveredNode && !this.graph.hasExtremity(edge, this.hoveredNode)) {
        res.hidden = true;
      }
      if (this.hoveredNode && this.graph.hasExtremity(edge, this.hoveredNode)) {
        res.hidden = false;
      }
      // Show and highlight edge connected to selected node
      if (this.selectedNode && this.graph.hasExtremity(edge, this.selectedNode)) {
        res.zIndex = 9000;
        res.color = "red";
        res.hidden = false;
      }
      // If there is a search query, the edge is only visible if it connects two suggestions
      if (
        this.suggestions &&
        (!this.suggestions.has(this.graph.source(edge)) || !this.suggestions.has(this.graph.target(edge)))
      ) {
        res.hidden = true;
      }
      if (this.hidePredicates.size > 0 && this.hidePredicates.has(data.label)) {
        res.hidden = true;
      }
      return res;
    });

    this.renderPredicateList();

    // Feed the datalist autocomplete values:
    const searchSuggestions = this.querySelector("#suggestions") as HTMLDataListElement;
    searchSuggestions.innerHTML = this.graph
      .nodes()
      .sort()
      .map(node => `<option value="${this.graph.getNodeAttribute(node, "label")}"></option>`)
      .join("\n");

    // Create the clustersLabel layer
    const clustersLayer = document.createElement("div");
    clustersLayer.id = "clustersLayer";
    clustersLayer.style.width = "100%";
    clustersLayer.style.height = "100%";
    clustersLayer.style.position = "absolute";
    let clusterLabelsDoms = "";
    for (const c in this.clusters) {
      // for each cluster create a div label
      const cluster = this.clusters[c];
      // adapt the position to viewport coordinates
      const viewportPos = this.renderer.graphToViewport(cluster as Coordinates);
      clusterLabelsDoms += `<div id='${cluster.label}' class="clusterLabel" style="top:${viewportPos.y}px;left:${viewportPos.x}px;color:${cluster.color}">${cluster.label}</div>`;
    }
    clustersLayer.innerHTML = clusterLabelsDoms;
    // Insert the layer underneath the hovers layer
    container.insertBefore(clustersLayer, container.querySelector(".sigma-hovers"));

    // Clusters labels position needs to be updated on each render
    this.renderer.on("afterRender", () => {
      for (const c in this.clusters) {
        const cluster = this.clusters[c];
        const clusterLabel = document.getElementById(cluster.label);
        if (clusterLabel && this.renderer) {
          // update position from the viewport
          const viewportPos = this.renderer.graphToViewport(cluster as Coordinates);
          clusterLabel.style.top = `${viewportPos.y}px`;
          clusterLabel.style.left = `${viewportPos.x}px`;
        }
      }
    });

    setTimeout(() => {
      layout.kill();
    }, 1500);
    // console.log(this.graph.getNodeAttributes("http://purl.uniprot.org/core/Protein"));
  }

  displayEdgeInfo(edge: string | undefined) {
    const edgeInfoDiv = this.querySelector("#metamap-edge-info") as HTMLElement;
    edgeInfoDiv.innerHTML = "";
    if (edge) {
      const edgeAttrs = this.graph.getEdgeAttributes(edge);
      console.log("edgeAttrs", edgeAttrs);
      // this.graph.connectedNodes(edge).forEach(n => {
      // this.graph.neighbors(edge).forEach(n => {
      //   console.log("neighbors", n);
      // })
      // edgeInfoDiv.innerHTML = `<h3>${edgeAttrs.label}</h3>`;
      // if (edgeAttrs.displayLabel) edgeInfoDiv.innerHTML += `<p>${edgeAttrs.displayLabel}</p>`;
      // if (edgeAttrs.comment) edgeInfoDiv.innerHTML += `<p>${edgeAttrs.comment}</p>`;
    }
    this.renderer?.refresh({skipIndexation: true});
  }

  displaySelectedNodeInfo(node: string | undefined) {
    this.selectedNode = node;
    const nodeInfoDiv = this.querySelector("#metamap-node-info") as HTMLElement;
    nodeInfoDiv.innerHTML = "";
    if (this.selectedNode) {
      const nodeAttrs = this.graph.getNodeAttributes(this.selectedNode);
      nodeInfoDiv.innerHTML = `<h3><a href="${node}" style="word-break: break-word;" target="_blank">${nodeAttrs.label}</a></h3>`;
      if (nodeAttrs.displayLabel) nodeInfoDiv.innerHTML += `<p>${nodeAttrs.displayLabel}</p>`;
      if (nodeAttrs.comment) nodeInfoDiv.innerHTML += `<p>${nodeAttrs.comment}</p>`;
      if (nodeAttrs.cluster)
        nodeInfoDiv.innerHTML += `<p>Cluster: <code style="background-color: ${this.clusters[nodeAttrs.cluster].color}">${nodeAttrs.cluster}</code></p>`;
      if (nodeAttrs.datatypes.length > 0) nodeInfoDiv.innerHTML += '<h5 style="margin: .5em;">Datatypes:</h5>';
      for (const dt of nodeAttrs.datatypes) {
        const dtDiv = document.createElement("div");
        dtDiv.innerHTML = `<a href="${dt.predUri}">${dt.predCurie}</a> <a href="${dt.datatypeUri}">${dt.datatypeCurie}</a> (${dt.count.toLocaleString()})`;
        nodeInfoDiv.appendChild(dtDiv);
      }
    }
    this.renderer?.refresh({skipIndexation: true});
  }

  // https://www.sigmajs.org/storybook/?path=/story/use-reducers--story
  setSearchQuery(query: string) {
    this.searchQuery = query;
    const searchInput = this.querySelector("#search-input") as HTMLInputElement;
    if (searchInput.value !== query) searchInput.value = query;
    if (query) {
      const lcQuery = query.toLowerCase();
      const suggestions = this.graph
        .nodes()
        .map(n => ({id: n, label: this.graph.getNodeAttribute(n, "label") as string}))
        .filter(({label}) => label.toLowerCase().includes(lcQuery));
      // If we have a single perfect match, them we remove the suggestions, and consider the user has selected a node
      if (suggestions.length === 1 && suggestions[0].label === query) {
        // this.selectedNode = suggestions[0].id;
        this.displaySelectedNodeInfo(suggestions[0].id);
        this.suggestions = undefined;
        // Move the camera to center it on the selected node:
        const nodePosition = this.renderer?.getNodeDisplayData(this.selectedNode) as Coordinates;
        this.renderer?.getCamera().animate(nodePosition, {duration: 500});
      } else {
        // Else, we display the suggestions list:
        // this.selectedNode = undefined;
        // this.displaySelectedNodeInfo(undefined);
        this.suggestions = new Set(suggestions.map(({id}) => id));
      }
    } else {
      // If the query is empty, then we reset the selectedNode / suggestions state:
      // this.selectedNode = undefined;
      this.suggestions = undefined;
    }
    // Refresh rendering, we don't touch the graph data so we can skip its reindexation
    this.renderer?.refresh({skipIndexation: true});
  }

  setHoveredNode(node?: string) {
    if (node) {
      this.hoveredNode = node;
      this.hoveredNeighbors = new Set(this.graph.neighbors(node));
    }
    // NOTE: hiding node done in the reducer function
    // // Compute the partial that we need to re-render to optimize the refresh
    // const nodes = this.graph.filterNodes(n => n !== this.hoveredNode && !this.hoveredNeighbors?.has(n));
    // // const nodesIndex = new Set(nodes);
    // // const edges = graph.filterEdges((e) => graph.extremities(e).some((n) => nodesIndex.has(n)));
    // const edges = this.graph.filterEdges(e => !this.graph.hasExtremity(e, node));
    if (!node) {
      this.hoveredNode = undefined;
      this.hoveredNeighbors = undefined;
    }
    // Refresh rendering
    this.renderer?.refresh({
      // partialGraph: {
      //   nodes,
      //   edges,
      // },
      // We don't touch the graph data so we can skip its reindexation
      skipIndexation: true,
    });
  }

  getCurie(uri: string) {
    return compressUri(this.prefixes, uri);
  }

  endpointUrl() {
    return Object.keys(this.endpoints)[0];
  }

  // loadMetaFromLocalStorage(): EndpointsMetadata {
  //   const metaString = localStorage.getItem("sparql-editor-metadata");
  //   return metaString ? JSON.parse(metaString) : {};
  // }

  // // Function to save metadata to localStorage
  // saveMetaToLocalStorage() {
  //   localStorage.setItem("sparql-editor-metadata", JSON.stringify(this.meta));
  // }

  // Get prefixes, VoID and examples
  async fetchEndpointMetadata(endpoint: string) {
    // if (!this.meta[endpoint].retrievedAt) {
    // console.log(`Getting metadata for ${endpoint}`);
    const [prefixes, voidInfo] = await Promise.all([getPrefixes(endpoint), queryEndpoint(voidQuery, endpoint)]);
    this.endpoints[endpoint].void = voidInfo;
    // this.prefixes = {...this.prefixes, ...prefixes};
    // Merge prefixes into `this.prefixes` one key at a time to avoid race conditions
    Object.assign(this.prefixes, prefixes);
    // this.meta[endpoint].retrievedAt = new Date();
    // this.saveMetaToLocalStorage();
  }

  renderPredicateList() {
    const sidebar = this.querySelector("#metamap-predicates-list") as HTMLElement;
    sidebar.innerHTML = "";
    const sortedPredicates = Object.entries(this.predicatesCount).sort((a, b) => b[1] - a[1]);

    for (const [predicateLabel, predicateCount] of sortedPredicates) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = predicateLabel;
      checkbox.checked = true;
      checkbox.onchange = () => this.togglePredicate(predicateLabel, checkbox.checked);

      const label = document.createElement("label");
      label.htmlFor = predicateLabel;
      label.textContent = `${predicateLabel} (${predicateCount.toLocaleString()})`;

      const container = document.createElement("div");
      container.appendChild(checkbox);
      container.appendChild(label);

      sidebar.appendChild(container);
    }
  }

  togglePredicate(predicateLabel: string, checked: boolean) {
    if (!checked) this.hidePredicates.add(predicateLabel);
    else this.hidePredicates.delete(predicateLabel);
    this.renderer?.refresh({skipIndexation: true});
  }
}

customElements.define("sparql-metamap", SparqlMetamap);
