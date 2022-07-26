/*
 * Copyright 2022, GeoSolutions Sas.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
*/

import Rx from 'rxjs';
import {get, omit} from "lodash";
import turfCenter from '@turf/center';
import turfBbox from '@turf/bbox';
import proj4 from 'proj4';

import {
    configSelector, dataSourceMode, geometrySelector,
    isDockOpen, isMaximized
} from "@js/extension/selectors";
import {
    CONTROL_DOCK_NAME, CONTROL_NAME, CONTROL_PROPERTIES_NAME,
    LONGITUDINAL_OWNER, LONGITUDINAL_VECTOR_LAYER_ID
} from "@js/extension/constants";

import {SET_CONTROL_PROPERTY, setControlProperty} from "@mapstore/actions/controls";
import {changeDrawingStatus, END_DRAWING} from "@mapstore/actions/draw";
import {
    addProfileData, changeDistance, changeReferential, initialized,
    loading, openDock, changeGeometry, toggleMaximize, toggleMode,
    SETUP, TEAR_DOWN, TOGGLE_MODE,
    CHANGE_GEOMETRY, CHANGE_DISTANCE, CHANGE_REFERENTIAL
} from "@js/extension/actions/longitudinal";
import {styleFeatures} from "@js/extension/utils/geojson";

import executeProcess, {makeOutputsExtractor} from "@mapstore/observables/wps/execute";
import {profileEnLong} from "@js/extension/observables/wps/profile";
import {wrapStartStop} from "@mapstore/observables/epics";

import {error} from "@mapstore/actions/notifications";
import {UPDATE_MAP_LAYOUT, updateDockPanelsList, updateMapLayout} from "@mapstore/actions/maplayout";
import {changeMapView, registerEventListener, unRegisterEventListener} from "@mapstore/actions/map";
import {removeAdditionalLayer, updateAdditionalLayer} from "@mapstore/actions/additionallayers";
import {
    changeMapInfoState,
    hideMapinfoMarker,
    purgeMapInfoResults, TOGGLE_MAPINFO_STATE,
    toggleMapInfoState
} from "@mapstore/actions/mapInfo";

import {highlightStyleSelector, mapInfoEnabledSelector} from "@mapstore/selectors/mapInfo";
import {mapSelector} from "@mapstore/selectors/map";

import {reprojectGeoJson} from "@mapstore/utils/CoordinatesUtils";
import {shutdownToolOnAnotherToolDrawing} from "@mapstore/utils/ControlUtils";
import {localConfigSelector} from "@mapstore/selectors/localConfig";

const OFFSET = 550;

const DEACTIVATE_ACTIONS = [
    changeDrawingStatus("stop"),
    changeDrawingStatus("clean", '', CONTROL_NAME)
];

const deactivate = () => Rx.Observable.from(DEACTIVATE_ACTIONS);

/**
 * Ensure that default configuration is applied whenever plugin is initialized
 * @param action$
 * @param store
 * @returns {*}
 */
export const setupLongitudinalExtension = (action$, store) =>
    action$.ofType(SETUP)
        .switchMap(({config: { referentiels, distances, defaultDistance, defaultReferentiel } = {}}) => {
            const state = store.getState();
            // adds projections from localConfig.json
            // Extension do not see the state proj4 of MapStore (can not reproject in custom CRS as mapstore does)
            // so projections have to be registered again in the extension.
            const {projectionDefs = []} = localConfigSelector(state) ?? {};
            projectionDefs.forEach((proj) => {
                proj4.defs(proj.code, proj.def);
            });

            return Rx.Observable.of(
                updateDockPanelsList(CONTROL_DOCK_NAME, "add", "right"),
                changeReferential(defaultReferentiel ?? referentiels[0].layerName),
                changeDistance(defaultDistance ?? distances[0]),
                updateAdditionalLayer(
                    LONGITUDINAL_VECTOR_LAYER_ID,
                    LONGITUDINAL_OWNER,
                    'overlay',
                    {
                        id: LONGITUDINAL_VECTOR_LAYER_ID,
                        features: [],
                        type: "vector",
                        name: "selectedLine",
                        visibility: true
                    }),
                initialized()
            );
        })
        .catch((e) => {
            console.log(e); // eslint-disable-line no-console
            return Rx.Observable.of(error({ title: "notification.error", message: "longitudinal.errors.unableToSetupPlugin" }));
        });

/**
 * Clean up state related to the plugin whenever it tears down
 * @param action$
 * @returns {*}
 */
export const cleanOnTearDown = (action$) =>
    action$.ofType(TEAR_DOWN)
        .switchMap(() => {
            return Rx.Observable.of(
                setControlProperty(CONTROL_NAME, 'enabled', false),
                setControlProperty(CONTROL_NAME, 'dataSourceMode', false),
                setControlProperty(CONTROL_DOCK_NAME, 'enabled', false),
                setControlProperty(CONTROL_PROPERTIES_NAME, 'enabled', false),
                updateDockPanelsList(CONTROL_NAME, "remove", "right"),
                removeAdditionalLayer({id: LONGITUDINAL_VECTOR_LAYER_ID, owner: LONGITUDINAL_OWNER})
            );
        });

/**
 * Adds support of drawing/selecting line whenever corresponding tools is activated via menu
 * @param action$
 * @param store
 * @returns {*}
 */
export const onDrawActivated = (action$, store) =>
    action$.ofType(TOGGLE_MODE)
        .switchMap(()=> {
            const state = store.getState();
            const mode = dataSourceMode(state);
            switch (mode) {
            case "draw":
                const startDrawingAction = changeDrawingStatus('start', "LineString", CONTROL_NAME, [], { stopAfterDrawing: true });
                return action$.ofType(END_DRAWING).flatMap(
                    ({ geometry }) => {
                        return Rx.Observable.of(changeGeometry(geometry))
                            .merge(
                                Rx.Observable.of(startDrawingAction).delay(200) // reactivate drawing
                            );
                    })
                    .startWith(
                        unRegisterEventListener('click', CONTROL_NAME),
                        changeMapInfoState(false),
                        purgeMapInfoResults(), hideMapinfoMarker(),
                        startDrawingAction
                    )
                    .takeUntil(action$.filter(({ type }) =>
                        type === TOGGLE_MODE && dataSourceMode(store.getState()) !== 'draw'
                    ))
                    .concat(deactivate());
            case "select":
                return Rx.Observable.from([
                    purgeMapInfoResults(), hideMapinfoMarker(),
                    ...(get(store.getState(), 'draw.drawOwner', '') === CONTROL_NAME ? DEACTIVATE_ACTIONS : []),
                    registerEventListener('click', CONTROL_NAME),
                    ...(mapInfoEnabledSelector(state) ? [toggleMapInfoState()] : [])
                ]);
            default:
                return Rx.Observable.from([
                    purgeMapInfoResults(), hideMapinfoMarker(),
                    ...(get(store.getState(), 'draw.drawOwner', '') === CONTROL_NAME ? DEACTIVATE_ACTIONS : []),
                    unRegisterEventListener('click', CONTROL_NAME)
                ]);
            }
        });

/**
 * Reload chart data from WPS whenever geometry or request configuration changed
 * @param action$
 * @param store
 * @returns {*}
 */
export const onChartPropsChange = (action$, store) =>
    action$.ofType(CHANGE_GEOMETRY, CHANGE_DISTANCE, CHANGE_REFERENTIAL)
        .filter(() => {
            const state = store.getState();
            return !!geometrySelector(state);
        })
        .switchMap(() => {
            const state = store.getState();
            const geometry = geometrySelector(state);
            const identifier = configSelector(state)?.identifier;
            const wpsurl = configSelector(state)?.wpsurl;
            const referentiel = configSelector(state)?.referential;
            const distance = configSelector(state)?.distance;
            return executeProcess(wpsurl, profileEnLong({identifier, geometry, distance, referentiel }),
                {outputsExtractor: makeOutputsExtractor()})
                .switchMap((result) => {
                    const feature = {
                        type: 'Feature',
                        geometry
                    };
                    const map = mapSelector(state);
                    const center = turfCenter(reprojectGeoJson(feature, geometry.projection, 'EPSG:4326')).geometry.coordinates;
                    const bbox = turfBbox(reprojectGeoJson(feature, geometry.projection, 'EPSG:4326'));
                    const [minx, minY, maxX, maxY] = bbox;
                    const { infos, points } = result?.profile ?? {};
                    const styledFeatures = styleFeatures([feature], omit(highlightStyleSelector(state), ["radius"]));
                    const features = styledFeatures && geometry.projection ? styledFeatures.map( f => reprojectGeoJson(
                        f,
                        geometry.projection
                    )) : styledFeatures;
                    return infos && points ? Rx.Observable.from([
                        updateAdditionalLayer(
                            LONGITUDINAL_VECTOR_LAYER_ID,
                            LONGITUDINAL_OWNER,
                            'overlay',
                            {
                                id: LONGITUDINAL_VECTOR_LAYER_ID,
                                features,
                                type: "vector",
                                name: "selectedLine",
                                visibility: true
                            }),
                        changeMapView({x: center[0], y: center[1]}, map.zoom, [minx, minY, maxX, maxY], map.size, null, map.projection),
                        addProfileData(infos, points)
                    ]) : Rx.Observable.empty();
                })
                .catch(e => {
                    console.log("Error while obtaining data for longitudinal profile"); // eslint-disable-line no-console
                    console.log(e); // eslint-disable-line no-console
                    return Rx.Observable.empty();
                })
                .let(wrapStartStop(
                    [loading(true), ...(!isDockOpen(state) ? [openDock()] : [])],
                    loading(false),
                    () => Rx.Observable.of(error({
                        title: "notification.error",
                        message: "longitudinal.errors.loadingError",
                        autoDismiss: 6,
                        position: "tc"
                    }))
                ));
        });

/**
 * Cleanup geometry when dock is closed
 * @param action$
 * @param store
 * @returns {*}
 */
export const onDockClosed = (action$, store) =>
    action$.ofType(SET_CONTROL_PROPERTY)
        .filter(({control, property, value}) => control === CONTROL_DOCK_NAME && property === 'enabled' && value === false)
        .switchMap(() => {
            return Rx.Observable.from([
                changeGeometry(false),
                removeAdditionalLayer({id: LONGITUDINAL_VECTOR_LAYER_ID, owner: LONGITUDINAL_OWNER}),
                ...(isMaximized(store.getState()) ? [toggleMaximize()] : [])
            ]);
        });

/**
 * Re-trigger an update map layout with the margin to adjust map layout and show navigation toolbar. This
 * also keep the zoom to extent offsets aligned with the current visibile window, so when zoom the longitudinal panel
 * is considered as a right offset and it will not cover the zoomed features.
 */
export const longitudinalMapLayout = (action$, store) =>
    action$.ofType(UPDATE_MAP_LAYOUT)
        .filter(({source}) => isDockOpen(store.getState()) &&  source !== CONTROL_NAME)
        .map(({layout}) => {
            const action = updateMapLayout({
                ...layout,
                right: OFFSET + (layout?.boundingSidebarRect?.right ?? 0),
                boundingMapRect: {
                    ...(layout.boundingMapRect || {}),
                    right: OFFSET + (layout?.boundingSidebarRect?.right ?? 0)
                },
                rightPanel: true
            });
            return { ...action, source: CONTROL_NAME }; // add an argument to avoid infinite loop.
        });

/**
 * Toggle longitudinal profile drawing/selection tool off when one of the drawing tools takes control
 * @param action$
 * @param store
 * @returns {Observable<unknown>}
 */
export const resetLongitudinalToolOnDrawToolActive = (action$, store) => shutdownToolOnAnotherToolDrawing(action$, store, CONTROL_NAME,
    () => {
        return Rx.Observable.of(toggleMode());
    },
    () => dataSourceMode(store.getState())
);

/**
 * Ensures that the active tool is getting deactivated when Identify tool is activated
 * @param {observable} action$ manages `TOGGLE_MAPINFO_STATE`
 * @param store
 * @return {observable}
 */
export const deactivateOnIdentifyEnabledEpic = (action$, store) =>
    action$
        .ofType(TOGGLE_MAPINFO_STATE)
        .filter(() => mapInfoEnabledSelector(store.getState()))
        .switchMap(() => {
            const mode = dataSourceMode(store.getState());
            return mode
                ? Rx.Observable.from([
                    toggleMode(false)
                ])
                : Rx.Observable.empty();
        });
