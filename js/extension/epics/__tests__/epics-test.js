/*
 * Copyright 2022, GeoSolutions Sas.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */
import expect from 'expect';

import { testEpic } from '@mapstore/epics/__tests__/epicTestUtils';

import {cleanOnTearDown, onDrawActivated, setupLongitudinalExtension} from "@js/extension/epics";
import {
    CHANGE_DISTANCE,
    CHANGE_REFERENTIAL,
    INITIALIZED,
    setup,
    tearDown,
    toggleMode
} from "@js/extension/actions/longitudinal";
import {UPDATE_DOCK_PANELS} from "@mapstore/actions/maplayout";
import {REMOVE_ADDITIONAL_LAYER, UPDATE_ADDITIONAL_LAYER} from "@mapstore/actions/additionallayers";
import {
    CONTROL_DOCK_NAME,
    CONTROL_NAME,
    CONTROL_PROPERTIES_NAME,
    LONGITUDINAL_VECTOR_LAYER_ID
} from "@js/extension/constants";
import {REGISTER_EVENT_LISTENER, UNREGISTER_EVENT_LISTENER} from "@mapstore/actions/map";
import {CHANGE_MAPINFO_STATE, HIDE_MAPINFO_MARKER, PURGE_MAPINFO_RESULTS} from "@mapstore/actions/mapInfo";
import {CHANGE_DRAWING_STATUS} from "@mapstore/actions/draw";

describe('Epics tests', () => {
    it('setupLongitudinalExtension', (done) => {
        const epicResult = actions => {
            try {
                expect(actions.length).toBe(5);
                actions.map((action) => {
                    switch (action.type) {
                    case UPDATE_DOCK_PANELS:
                        expect(action.name).toBe(CONTROL_DOCK_NAME);
                        expect(action.action).toBe('add');
                        expect(action.location).toBe('right');
                        break;
                    case CHANGE_REFERENTIAL:
                        expect(action.referential).toBe("sfdem");
                        break;
                    case CHANGE_DISTANCE:
                        expect(action.distance).toBe(100);
                        break;
                    case UPDATE_ADDITIONAL_LAYER:
                        expect(action.id).toBe(LONGITUDINAL_VECTOR_LAYER_ID);
                        break;
                    case INITIALIZED:
                        break;
                    default:
                        done(new Error("Action not recognized"));
                    }
                });
            } catch (e) {
                done(e);
            }
            done();
        };
        const config = {
            "wpsurl": "/geoserver/wps",
            "identifier": "gs:ProfilEnLong",
            "referentiels": [
                {
                    "layerName": "sfdem",
                    "title": "sfdem"
                }
            ],
            "distances": [
                1,
                5,
                10,
                50,
                100,
                500,
                1000,
                5000
            ],
            "defaultDistance": 100,
            "defaultReferentiel": "sfdem"
        };
        const state = {localconfig: { metadataexplorer: {enabled: true}, queryPanel: {enabled: true}}};
        testEpic(setupLongitudinalExtension, 5, setup(config), epicResult, state);
    });
    it('cleanOnTearDown', (done) => {
        const epicResult = actions => {
            try {
                expect(actions.length).toBe(6);
                actions.slice(0, 3).map((action, key) => {
                    switch (key) {
                    case 0:
                        expect(action.control).toBe(CONTROL_NAME);
                        expect(action.property).toBe('enabled');
                        break;
                    case 1:
                        expect(action.control).toBe(CONTROL_NAME);
                        expect(action.property).toBe('dataSourceMode');
                        break;
                    case 2:
                        expect(action.control).toBe(CONTROL_DOCK_NAME);
                        break;
                    case 3:
                        expect(action.control).toBe(CONTROL_PROPERTIES_NAME);
                        break;
                    default:
                        done(new Error("Action not recognized"));
                    }
                });
                actions.slice(4).map((action) => {
                    switch (action.type) {
                    case UPDATE_DOCK_PANELS:
                        expect(action.name).toBe(CONTROL_NAME);
                        expect(action.action).toBe("remove");
                        expect(action.location).toBe("right");
                        break;
                    case REMOVE_ADDITIONAL_LAYER:
                        expect(action.id).toBe(LONGITUDINAL_VECTOR_LAYER_ID);
                        break;
                    default:
                        // eslint-disable-next-line no-console
                        console.log(action);
                        done(new Error("Action not recognized"));
                    }
                });
            } catch (e) {
                done(e);
            }
            done();
        };
        const state = {};
        testEpic(cleanOnTearDown, 6, tearDown(), epicResult, state);
    });
    it('onDrawActivated - draw', (done) => {
        const epicResult = actions => {
            try {
                expect(actions.length).toBe(5);
                actions.map((action) => {
                    switch (action.type) {
                    case UNREGISTER_EVENT_LISTENER:
                        expect(action.toolName).toBe(CONTROL_NAME);
                        expect(action.eventName).toBe('click');
                        break;
                    case CHANGE_MAPINFO_STATE:
                        expect(action.enabled).toBe(false);
                        break;
                    case PURGE_MAPINFO_RESULTS:
                    case HIDE_MAPINFO_MARKER:
                        break;
                    case CHANGE_DRAWING_STATUS:
                        expect(action.status).toBe("start");
                        expect(action.method).toBe("LineString");
                        expect(action.owner).toBe("longitudinalProfile");
                        break;
                    default:
                        done(new Error("Action not recognized"));
                    }
                });
            } catch (e) {
                done(e);
            }
            done();
        };
        const state = {longitudinal: { mode: 'draw'}};
        testEpic(onDrawActivated, 5, toggleMode('draw'), epicResult, state);
    });
    it('onDrawActivated - select', (done) => {
        const epicResult = actions => {
            try {
                expect(actions.length).toBe(5);
                actions.map((action) => {
                    switch (action.type) {
                    case REGISTER_EVENT_LISTENER:
                        expect(action.toolName).toBe(CONTROL_NAME);
                        expect(action.eventName).toBe('click');
                        break;
                    case CHANGE_MAPINFO_STATE:
                        expect(action.enabled).toBe(false);
                        break;
                    case PURGE_MAPINFO_RESULTS:
                    case HIDE_MAPINFO_MARKER:
                        break;
                    case CHANGE_DRAWING_STATUS:
                        expect(['clean', 'stop'].includes(action.status)).toBe(true);
                        break;
                    default:
                        done(new Error("Action not recognized"));
                    }
                });
            } catch (e) {
                done(e);
            }
            done();
        };
        const state = {
            longitudinal: { mode: 'select'},
            draw: { drawOwner: CONTROL_NAME}
        };
        testEpic(onDrawActivated, 5, toggleMode('select'), epicResult, state);
    });
    it('onDrawActivated - unselected', (done) => {
        const epicResult = actions => {
            try {
                expect(actions.length).toBe(4);
                actions.map((action) => {
                    switch (action.type) {
                    case UNREGISTER_EVENT_LISTENER:
                        expect(action.toolName).toBe(CONTROL_NAME);
                        expect(action.eventName).toBe('click');
                        break;
                    case PURGE_MAPINFO_RESULTS:
                    case HIDE_MAPINFO_MARKER:
                        break;
                    case CHANGE_DRAWING_STATUS:
                        expect(['clean', 'stop'].includes(action.status)).toBe(true);
                        break;
                    default:
                        done(new Error("Action not recognized"));
                    }
                });
            } catch (e) {
                done(e);
            }
            done();
        };
        const state = {
            longitudinal: { mode: 'select'},
            draw: { drawOwner: CONTROL_NAME}
        };
        testEpic(onDrawActivated, 4, toggleMode('select'), epicResult, state);
    });
});
