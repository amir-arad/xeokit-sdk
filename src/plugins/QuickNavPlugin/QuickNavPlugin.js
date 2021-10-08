import {Plugin} from "../../viewer/Plugin.js";
import {getObjectCullStates} from "../lib/culling/ObjectCullStates";
import {math} from "../../viewer";
import {Frustum, frustumIntersectsAABB3, setFrustum} from "../../viewer/scene/math/Frustum";

const MAX_KD_TREE_DEPTH = 8; // Increase if greater precision needed

const kdTreeDimLength = new Float32Array(3);

/**
 * {@link Viewer} plugin that improves interactivity by disabling expensive rendering effects while the {@link Camera} is moving.
 *
 * # Usage
 *
 * In the example below, we'll create a {@link Viewer}, add a {@link QuickNavPlugin}, then use an {@link XKTLoaderPlugin} to load a model.
 *
 * This viewer will only render the model with enhanced edges, physically-based rendering (PBR) and scalable
 * ambient obscurance (SAO) when the camera is not moving.
 *
 * Note how we enable SAO and PBR on the ````Scene```` and the model.
 *
 * * [[Run this example](https://xeokit.github.io/xeokit-sdk/examples/#performance_QuickNavPlugin)]
 *
 * ````javascript
 * import {Viewer, XKTLoaderPlugin, QuickNavPlugin} from "xeokit-sdk.es.js";
 *
 * const viewer = new Viewer({
 *      canvasId: "myCanvas",
 *      transparent: true,
 *      pbrEnabled: true,
 *      saoEnabled: true
 *  });
 *
 * viewer.scene.camera.eye = [-66.26, 105.84, -281.92];
 * viewer.scene.camera.look = [42.45, 49.62, -43.59];
 * viewer.scene.camera.up = [0.05, 0.95, 0.15];
 *
 * new QuickNavPlugin(viewer, {
 *     showObjectsWhileMoving: {
 *         maxTriangles: 1000,
 *         minDiagSize: 10
 *     },
 *     showEffectsWhileMoving: {
 *         pbr: false,
 *         edges: false
 *     }
 * });
 *
 * const xktLoader = new XKTLoaderPlugin(viewer);
 *
 * const model = xktLoader.load({
 *      id: "myModel",
 *      src: "./models/xkt/HolterTower.xkt",
 *      edges: true,
 *      hideSAO: true,
 *      hidePBR: true
 * });
 * ````
 *
 * @class QuickNavPlugin
 */
class QuickNavPlugin extends Plugin {

    /**
     * @constructor
     * @param {Viewer} viewer The Viewer.
     * @param {Object} cfg QuickNavPlugin configuration.
     * @param {String} [cfg.id="FastNav"] Optional ID for this plugin, so that we can find it within {@link Viewer#plugins}.
     * @param {Boolean} [cfg.hidePBR=true] Whether to disable physically-based rendering (PBR) when the camera is moving.
     * @param {Boolean} [cfg.hideSAO=true] Whether to disable scalable ambient occlusion (SAO) when the camera is moving.
     * @param {Boolean} [cfg.hideEdges=true] Whether to hide enhanced edges when the camera is moving.
     * @param {Number} [cfg.hideSmallerThan=0]
     * @param {Number} [cfg.hideMoreTrianglesThan=0]
     * @param {String[]} [cfg.hideTypes]
     * @param {String[]} [cfg.dontHideTypes]
     */
    constructor(viewer, cfg = {}) {

        super("FastNav", viewer);

        this._hidePBR = (cfg.hidePBR !== undefined && cfg.hidePBR !== null) ? cfg.hidePBR : viewer.scene.hidePBR;
        this._hideSAO = (cfg.hideSAO !== undefined && cfg.hideSAO !== null) ? cfg.hideSAO : viewer.scene.sao.enabled;
        this._hideEdges = (cfg.hideEdges !== undefined && cfg.hideEdges !== null) ? cfg.hideEdges : viewer.scene.edgeMaterial.edges;

        this._maxTreeDepth = MAX_KD_TREE_DEPTH;
        this._modelInfos = {};
        this._frustum = new Frustum();
        this._kdRoot = null;

        this._objectCullStates = getObjectCullStates(viewer.scene); // Combines updates from multiple culling systems for its Scene's Entities
        this._modelInfos = {};

        this._hideSmallerThan = 409;
        this._hideMoreTrianglesThan = 14;
        this._hideTypes = {};
        this._dontHideTypes = {};

        this._cullSet = [];
        this._cullSetLen = 0;

        this._cullSetDirty = true;
        this._frustumDirty = false;
        this._kdTreeDirty = false;

        this._pInterval = null;
        this._fadeMillisecs = 500;

        let timeoutDuration = 600; // Milliseconds
        let timer = timeoutDuration;
        let fastMode = false;

        this._onModelLoaded = viewer.scene.on("modelLoaded", (modelId) => {
            const model = this.viewer.scene.models[modelId];
            if (model) {
                this._addModel(model);
            }
        });

        const startHiding = () => {
            timer = timeoutDuration;
            if (!fastMode) {
                this._cancelFade();
                if (this._hidePBR) {
                    viewer.scene.pbr = false;
                }
                if (this._hideSAO) {
                    viewer.scene.sao.enabled = false;
                }
                if (this._hideEdges) {
                    viewer.scene.edgeMaterial.edges = false;
                }
                this._setObjectsCulled(true);
                fastMode = true;
            }
            this._frustumDirty = true;
        };

        this._onCanvasBoundary = viewer.scene.canvas.on("boundary", startHiding);
        this._onViewMatrix = viewer.scene.camera.on("viewMatrix", startHiding);
        this._onProjMatrix = viewer.scene.camera.on("projMatrix", startHiding);

        this._onSceneTick = viewer.scene.on("tick", (tickEvent) => {  // Milliseconds
            if (!fastMode) {
                return;
            }
            timer -= tickEvent.deltaTime;
            if (timer <= 0) {
                if (fastMode) {
                    this._startFade();
                    this._pInterval2 = setTimeout(() => { // Needed by Firefox - https://github.com/xeokit/xeokit-sdk/issues/624
                        if (this._hidePBR) {
                            viewer.scene.pbr = true;
                        }
                        if (this._hideSAO) {
                            viewer.scene.sao.enabled = true;
                        }
                        if (this._hideEdges) {
                            viewer.scene.edgeMaterial.edges = true;
                        }
                        this._setObjectsCulled(false);
                    }, 100);
                    fastMode = false;
                }
            }
        });

        let down = false;

        this._onSceneMouseDown = viewer.scene.input.on("mousedown", () => {
            down = true;
        });

        this._onSceneMouseUp = viewer.scene.input.on("mouseup", () => {
            down = false;
        });

        this._onSceneMouseMove = viewer.scene.input.on("mousemove", () => {
            if (!down) {
                return;
            }
            startHiding();
        });

        this.hidePBR = cfg.hidePBR;
        this.hideSAO = cfg.hideSAO;
        this.hideEdges = cfg.hideEdges;

        this.hideSmallerThan = cfg.hideSmallerThan;
        this.hideMoreTrianglesThan = cfg.hideMoreTrianglesThan;
        this.hideTypes = cfg.hideTypes;
        this.dontHideTypes = cfg.dontHideTypes;
    }

    /**
     * Gets whether to disable physically-based rendering (PBR) while the camera moves.
     *
     * @return {Boolean} Whether PBR will be enabled.
     */
    get hidePBR() {
        return this._hidePBR
    }

    /**
     * Sets whether to disable physically-based rendering (PBR) while the camera moves.
     *
     * @return {Boolean} Whether PBR will be enabled.
     */
    set hidePBR(hidePBR) {
        this._hidePBR = hidePBR;
    }

    /**
     * Gets whether the QuickNavPlugin enables SAO when switching to quality rendering.
     *
     * @return {Boolean} Whether SAO will be enabled.
     */
    get hideSAO() {
        return this._hideSAO
    }

    /**
     * Sets whether to enable scalable ambient occlusion (SAO) when the camera stops moving.
     *
     * @return {Boolean} Whether SAO will be enabled.
     */
    set hideSAO(hideSAO) {
        this._hideSAO = hideSAO;
    }

    /**
     * Gets whether to show enhanced edges when the camera stops moving.
     *
     * @return {Boolean} Whether edge enhancement will be enabled.
     */
    get hideEdges() {
        return this._hideEdges
    }

    /**
     * Sets whether to show enhanced edges when the camera stops moving.
     *
     * @return {Boolean} Whether edge enhancement will be enabled.
     */
    set hideEdges(hideEdges) {
        this._hideEdges = hideEdges;
    }

    /**
     * Gets the minimum object size for detail culling.
     *
     * @returns {Number} The minimum object size for detail culling.
     */
    get hideSmallerThan() {
        return this._hideSmallerThan;
    }

    /**
     * Sets the minimum object size for detail culling.
     *
     * @param {Number} value The minimum object size for detail culling.
     */
    set hideSmallerThan(value) {
        this._hideSmallerThan = (value !== undefined && value !== null) ? value : 0;
        this._cullSetDirty = true;
    }

    /**
     * Gets the maximum object size for detail culling.
     *
     * @returns {Number} The minimum object size for detail culling.
     */
    get hideMoreTrianglesThan() {
        return this._hideMoreTrianglesThan;
    }

    /**
     * Sets the maximum number of triangles for detail culling.
     *
     * @param {Number} value The minimum object size for detail culling.
     */
    set hideMoreTrianglesThan(value) {
        this._hideMoreTrianglesThan = (value !== undefined && value !== null) ? value : 0;
        this._cullSetDirty = true;
    }

    /**
     * Gets which object types to cull.
     *
     * @return {String[]} hideTypes List of types to cull.
     */
    get hideTypes() {
        return this._hideTypes;
    }

    /**
     * Sets which object types to cull.
     *
     * @param {String[]} hideTypes List of types to cull.
     */
    set hideTypes(hideTypes) {
        this._hideTypes = hideTypes || [];
        this._hideTypesMap = {};
        this._hideTypes.map((type => {
            this._hideTypesMap[type] = true;
        }));
        this._cullSetDirty = true;
    }

    /**
     * Gets which object types to **not** cull.
     *
     * @return {Boolean} List of types to not cull.
     */
    get dontHideTypes() {
        return this._dontHideTypes;
    }

    /**
     * Sets which object types to **not** cull.
     *
     * @param {String[]} dontHideTypes List of types to not cull.
     */
    set dontHideTypes(dontHideTypes) {
        this._dontHideTypes = dontHideTypes || [];
        this._dontHideTypesMap = {};
        this._dontHideTypes.map((type => {
            this._dontHideTypesMap[type] = true;
        }));
        this._cullSetDirty = true;
    }

    _addModel(model) {
        const modelInfo = {
            model: model,
            onDestroyed: model.on("destroyed", () => {
                this._removeModel(model);
            })
        };
        this._modelInfos[model.id] = modelInfo;
        this._cullSetDirty = true;
        this._kdTreeDirty = true;
    }

    _removeModel(model) {
        const modelInfo = this._modelInfos[model.id];
        if (modelInfo) {
            modelInfo.model.off(modelInfo.onDestroyed);
            delete this._modelInfos[model.id];
            this._cullSetDirty = true;
            this._kdTreeDirty = true;
        }
    }

    _getObjectsInViewFrustum() { // Called at start of every cull
        // Lazy-rebuild map of object IDs if dirty, which happens after the camera has moved or projection changed
    }

    _setObjectsCulled(culled) {
        if (this._cullSetDirty) {
            this._buildCullObjects();
        }
        for (let i = 0, len = this._cullSet.length; i < len; i++) {
            const objectIdx = this._cullSet[i];

            // TODO: Don't cull object if it's in the view frustum list

            this._objectCullStates.setObjectDetailCulled(objectIdx, culled);
        }
        this._culling = culled;
    }

    _buildCullObjects() {
        // Builds list of objects to cull
        // Each object is culled if:
        //  - has a MetaObject with type that is registered in hideTypes, and not registered in dontHideTypes
        //  - hideMoreTrianglesThan is non-zero and greater than the object's number of triangles
        //  - hideSmallerThan is non-zero and greater than the object's size (the largest diagonal of the objects AABB)
        for (let i = 0; i < this._cullSetLen; i++) {
            const objectIdx = this._cullSet[i];
            const culled = false;
            this._objectCullStates.setObjectViewCulled(objectIdx, culled);
        }
        this._cullSetLen = 0;
        const hideMoreTrianglesThanEnabled = (this._hideMoreTrianglesThan !== 0);
        const hideSmallerThanEnabled = (this._hideSmallerThan !== 0);
        for (let objectIdx = 0, len = this._objectCullStates.numObjects; objectIdx < len; objectIdx++) {
            const entity = this._objectCullStates.objects[objectIdx];
            const metaObject = this.viewer.metaScene.metaObjects[entity.id];
            if (metaObject) {
                if (this._dontHideTypesMap[metaObject.type]) { // Never hide this type
                    continue;
                }
                if (this._hideTypesMap[metaObject.type]) {  // Always hide this type
                    this._cullSet[this._cullSetLen++] = objectIdx;
                    continue;
                }
            }
            if (hideMoreTrianglesThanEnabled) {
                const entityNumTriangles = entity.numTriangles;
                if (hideSmallerThanEnabled) {
                    const entitySize = math.getAABB3Diag(entity.aabb);
                    const needCull = (this._hideMoreTrianglesThan <= entityNumTriangles && entitySize <= this._hideSmallerThan);
                    if (needCull) { // Entity is smaller than min size and has too many triangles
                        this._cullSet[this._cullSetLen++] = objectIdx;
                    }
                } else {
                    const needCull = (this._hideMoreTrianglesThan <= entityNumTriangles);
                    if (needCull) { // Entity has too many triangles
                        this._cullSet[this._cullSetLen++] = objectIdx;
                    }
                }
            } else {
                if (hideSmallerThanEnabled) { // Entity is too small
                    const entitySize = math.getAABB3Diag(entity.aabb);
                    const needCull = (entitySize <= this._hideSmallerThan);
                    if (needCull) {
                        this._cullSet[this._cullSetLen++] = objectIdx;
                    }
                }
            }
        }
        this._cullSetDirty = false;
    }

    _startFade() {

        if (!this._img) {
            this._initFade();
        }

        const interval = 50;
        const inc = 1 / (this._fadeMillisecs / interval);

        if (this._pInterval) {
            clearInterval(this._pInterval);
            this._pInterval = null;
        }

        const viewer = this.viewer;

        const canvas = viewer.scene.canvas.canvas;
        const canvasOffset = cumulativeOffset(canvas);
        const zIndex = (parseInt(canvas.style["z-index"]) || 0) + 1;
        this._img.style.position = "fixed";
        this._img.style["margin"] = 0 + "px";
        this._img.style["z-index"] = zIndex;
        this._img.style["background"] = canvas.style.background;
        this._img.style.left = canvasOffset.left + "px";
        this._img.style.top = canvasOffset.top + "px";
        this._img.style.width = canvas.width + "px";
        this._img.style.height = canvas.height + "px";
        this._img.width = canvas.width;
        this._img.height = canvas.height;
        this._img.src = ""; // Needed by Firefox - https://github.com/xeokit/xeokit-sdk/issues/624
        this._img.src = viewer.getSnapshot({
            format: "png",
            includeGizmos: true
        });
        this._img.style.visibility = "visible";
        this._img.style.opacity = 1;

        let opacity = 1;
        this._pInterval = setInterval(() => {
            opacity -= inc;
            if (opacity > 0) {
                this._img.style.opacity = opacity;
                const canvasOffset = cumulativeOffset(canvas);
                this._img.style.left = canvasOffset.left + "px";
                this._img.style.top = canvasOffset.top + "px";
                this._img.style.width = canvas.width + "px";
                this._img.style.height = canvas.height + "px";
                this._img.style.opacity = opacity;
                this._img.width = canvas.width;
                this._img.height = canvas.height;

            } else {
                this._img.style.opacity = 0;
                this._img.style.visibility = "hidden";
                clearInterval(this._pInterval);
                this._pInterval = null;
            }
        }, interval);
    }

    _initFade() {
        this._img = document.createElement('img');
        const canvas = this.viewer.scene.canvas.canvas;
        const canvasOffset = cumulativeOffset(canvas);
        const zIndex = (parseInt(canvas.style["z-index"]) || 0) + 1;
        this._img.style.position = "absolute";
        this._img.style.visibility = "hidden";
        this._img.style["pointer-events"] = "none";
        this._img.style["z-index"] = zIndex;
        this._img.style.left = canvasOffset.left + "px";
        this._img.style.top = canvasOffset.top + "px";
        this._img.style.width = canvas.width + "px";
        this._img.style.height = canvas.height + "px";
        this._img.style.opacity = 1;
        this._img.width = canvas.width;
        this._img.height = canvas.height;
        this._img.left = canvasOffset.left;
        this._img.top = canvasOffset.top;
        canvas.parentNode.insertBefore(this._img, canvas.nextSibling);
    }

    _cancelFade() {
        if (!this._img) {
            return;
        }
        if (this._pInterval) {
            clearInterval(this._pInterval);
            this._pInterval = null;
        }
        if (this._pInterval2) {
            clearInterval(this._pInterval2);
            this._pInterval2 = null;
        }
        this._img.style.opacity = 0;
        this._img.style.visibility = "hidden";
    }

    _getObjectsInFrustum() {
        const objectIds = {};
        const cullDirty = (this._frustumDirty || this._kdTreeDirty);
        if (this._frustumDirty) {
            this._buildFrustum();
        }
        if (this._kdTreeDirty) {
            this._buildKDTree();
        }
        // if (cullDirty) {
        //     const kdNode = this._kdRoot;
        //     if (kdNode) {
        //         this._visitKDNode(kdNode);
        //     }
        // }
        return objectIds;
    }
    
    _buildFrustum() {
        const camera = this.viewer.scene.camera;
        setFrustum(this._frustum, camera.viewMatrix, camera.projMatrix);
        this._frustumDirty = false;
    }

    _buildKDTree() {
        const viewer = this.viewer;
        const scene = viewer.scene;
        const depth = 0;
        if (this._kdRoot) {
            // TODO: uncull all objects with respect to this frustum culling plugin?
        }
        this._kdRoot = {
            aabb: scene.getAABB(),
            intersection: Frustum.INTERSECT
        };
        for (let objectIdx = 0, len = this._objectCullStates.numObjects; objectIdx < len; objectIdx++) {
            const entity = this._objectCullStates.objects[objectIdx];
            this._insertEntityIntoKDTree(this._kdRoot, entity, objectIdx, depth + 1);
        }
        this._kdTreeDirty = false;
    }

    _insertEntityIntoKDTree(kdNode, entity, objectIdx, depth) {

        const entityAABB = entity.aabb;

        if (depth >= this._maxTreeDepth) {
            kdNode.objects = kdNode.objects || [];
            kdNode.objects.push(objectIdx);
            math.expandAABB3(kdNode.aabb, entityAABB);
            return;
        }

        if (kdNode.left) {
            if (math.containsAABB3(kdNode.left.aabb, entityAABB)) {
                this._insertEntityIntoKDTree(kdNode.left, entity, objectIdx, depth + 1);
                return;
            }
        }

        if (kdNode.right) {
            if (math.containsAABB3(kdNode.right.aabb, entityAABB)) {
                this._insertEntityIntoKDTree(kdNode.right, entity, objectIdx, depth + 1);
                return;
            }
        }

        const nodeAABB = kdNode.aabb;

        kdTreeDimLength[0] = nodeAABB[3] - nodeAABB[0];
        kdTreeDimLength[1] = nodeAABB[4] - nodeAABB[1];
        kdTreeDimLength[2] = nodeAABB[5] - nodeAABB[2];

        let dim = 0;

        if (kdTreeDimLength[1] > kdTreeDimLength[dim]) {
            dim = 1;
        }

        if (kdTreeDimLength[2] > kdTreeDimLength[dim]) {
            dim = 2;
        }

        if (!kdNode.left) {
            const aabbLeft = nodeAABB.slice();
            aabbLeft[dim + 3] = ((nodeAABB[dim] + nodeAABB[dim + 3]) / 2.0);
            kdNode.left = {
                aabb: aabbLeft,
                intersection: Frustum.INTERSECT
            };
            if (math.containsAABB3(aabbLeft, entityAABB)) {
                this._insertEntityIntoKDTree(kdNode.left, entity, objectIdx, depth + 1);
                return;
            }
        }

        if (!kdNode.right) {
            const aabbRight = nodeAABB.slice();
            aabbRight[dim] = ((nodeAABB[dim] + nodeAABB[dim + 3]) / 2.0);
            kdNode.right = {
                aabb: aabbRight,
                intersection: Frustum.INTERSECT
            };
            if (math.containsAABB3(aabbRight, entityAABB)) {
                this._insertEntityIntoKDTree(kdNode.right, entity, objectIdx, depth + 1);
                return;
            }
        }

        kdNode.objects = kdNode.objects || [];
        kdNode.objects.push(objectIdx);

        math.expandAABB3(kdNode.aabb, entityAABB);
    }

    _visitKDNode(kdNode, intersects = Frustum.INTERSECT, objectIDMap) {
        if (intersects !== Frustum.INTERSECT && kdNode.intersects === intersects) {
            return;
        }
        if (intersects === Frustum.INTERSECT) {
            intersects = frustumIntersectsAABB3(this._frustum, kdNode.aabb);
            kdNode.intersects = intersects;
        }
        const culled = (intersects === Frustum.OUTSIDE);
        const objects = kdNode.objects;
        if (objects && objects.length > 0) {
            for (let i = 0, len = objects.length; i < len; i++) {
                const objectIdx = objects[i];
                // objectIDMap[objectIdx] = object;
                // this._objectCullStates.setObjectViewCulled(objectIdx, culled);
            }
        }
        if (kdNode.left) {
            this._visitKDNode(kdNode.left, intersects);
        }
        if (kdNode.right) {
            this._visitKDNode(kdNode.right, intersects);
        }
    }

    /**
     * @private
     */
    send(name, value) {
        switch (name) {
            case "clear":
                this._cancelFade();
                break;
        }
    }

    /**
     * Destroys this plugin.
     */
    destroy() {

        this._cancelFade();

        const scene = this.viewer.scene;
        const camera = scene.camera;

        camera.off(this._onProjMatrix);
        camera.off(this._onViewMatrix);
        scene.canvas.off(this._onCanvasBoundary);
        scene.input.off(this._onSceneMouseDown);
        scene.input.off(this._onSceneMouseUp);
        scene.input.off(this._onSceneMouseMove);
        scene.off(this._onSceneTick);
        scene.off(this._onModelLoaded);

        for (let modelId in this._modelInfos) {
            const modelInfo = this._modelInfos[modelId];
            modelInfo.model.off(modelInfo.onDestroyed);
        }
        for (let i = 0; i < this._cullSetLen; i++) {
            const objectIdx = this._cullSet[i];
            const culled = false;
            this._objectCullStates.setObjectDetailCulled(objectIdx, culled);
        }
        this._modelInfos = {};
        this._cullSet = [];
        this._cullSetLen = 0;

        super.destroy();

        if (this._img) {
            this._img.parentNode.removeChild(this._img);
            this._img = null;
        }
    }
}

function cumulativeOffset(element) {
    let top = 0, left = 0;
    do {
        top += element.offsetTop || 0;
        left += element.offsetLeft || 0;
        element = element.offsetParent;
    } while (element);

    return {
        top: top,
        left: left
    };
}

export {QuickNavPlugin}