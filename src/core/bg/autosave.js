/*
 * Copyright 2010-2020 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global browser, URL, Blob, setTimeout, clearTimeout */

import * as config from "./config.js";
import * as business from "./business.js";
import * as companion from "./companion.js";
import * as downloads from "./downloads.js";
import * as tabsData from "./tabs-data.js";
import * as ui from "./../../ui/bg/index.js";
import { getPageData } from "./../../index.js";
import * as woleet from "./../../lib/woleet/woleet.js";
import { autoSaveIsEnabled } from "./autosave-util.js";
import { enableReferrerOnError } from "./requests.js";
import { fetchResource } from "./../../lib/single-file/fetch/bg/fetch.js";

const AUTOSAVE_PORT_NAME_PREFIX = "singlefile.autosave:";
// time left to the content sent when a page is unloaded to be received before saving the last
// snapshot of the page instead
const PROVISIONAL_SAVE_DELAY = 2000;
const FLUSHED_SAVE_ID_TTL = 60000;

const pendingMessages = {};
const replacedTabIds = {};
// last snapshots of the pages waiting to be auto-saved, indexed by document id
const provisionalPages = new Map();
const flushedSaveIds = new Set();

if (browser.runtime.onConnect) {
	browser.runtime.onConnect.addListener(port => {
		if (port.name && port.name.startsWith(AUTOSAVE_PORT_NAME_PREFIX)) {
			const documentId = port.name.substring(AUTOSAVE_PORT_NAME_PREFIX.length);
			// the page is gone (tab closed, navigation, crash...)
			port.onDisconnect.addListener(() => flushProvisionalPage(documentId));
		}
	});
}

export {
	onMessage,
	onMessageExternal,
	onInit,
	onTabUpdated,
	onTabRemoved,
	onTabDiscarded,
	onTabReplaced
};

async function onMessage(message, sender) {
	if (message.method.endsWith(".discardProvisional")) {
		const provisionalPage = provisionalPages.get(message.documentId);
		if (provisionalPage) {
			clearTimeout(provisionalPage.timeout);
			provisionalPages.delete(message.documentId);
		}
		return {};
	}
	if (message.method.endsWith(".save")) {
		// when the tab is being closed, the content sent on unload is received without sender.tab
		const tab = sender.tab || getRemovedTab(message, sender);
		if (message.autoSaveProvisional) {
			setProvisionalPage(message, tab);
			return {};
		}
		if (message.saveId && flushedSaveIds.has(message.saveId)) {
			// the page has already been saved from its last snapshot
			return {};
		}
		if (message.autoSaveDiscard || message.autoSaveRemove) {
			if (sender.tab) {
				message.tab = sender.tab;
				pendingMessages[sender.tab.id] = message;
			} else if (pendingMessages[message.tabId] &&
				((pendingMessages[message.tabId].removed && message.autoSaveRemove) ||
					(pendingMessages[message.tabId].discarded && message.autoSaveDiscard))
			) {
				delete pendingMessages[message.tabId];
				await saveContent(message, tab);
			}
			if (message.autoSaveUnload) {
				delete pendingMessages[message.tabId];
				await saveContent(message, tab);
			}
		} else {
			delete pendingMessages[message.tabId];
			await saveContent(message, tab);
		}
		return {};
	}
}

function getRemovedTab(message, sender) {
	return {
		id: message.tabId,
		index: message.tabIndex,
		url: message.url || sender.url,
		incognito: Boolean(message.incognito),
		removed: true
	};
}

function setProvisionalPage(message, tab) {
	const provisionalPage = provisionalPages.get(message.documentId);
	// another page is displayed in the tab: the snapshot of the previous one must be saved
	provisionalPages.forEach((otherProvisionalPage, documentId) => {
		if (otherProvisionalPage.tab.id == tab.id && documentId != message.documentId) {
			flushProvisionalPage(documentId);
		}
	});
	provisionalPages.set(message.documentId, {
		message,
		tab: { id: tab.id, index: tab.index, url: message.url, incognito: tab.incognito, windowId: tab.windowId },
		timeout: provisionalPage && provisionalPage.timeout
	});
}

function discardProvisionalPage(message) {
	const provisionalPage = provisionalPages.get(message.documentId);
	if (provisionalPage && provisionalPage.message.saveId == message.saveId) {
		clearTimeout(provisionalPage.timeout);
		provisionalPages.delete(message.documentId);
	}
}

function flushProvisionalPage(documentId) {
	const provisionalPage = provisionalPages.get(documentId);
	if (provisionalPage && !provisionalPage.timeout) {
		provisionalPage.timeout = setTimeout(async () => {
			// the snapshot may have been updated meanwhile
			const lastProvisionalPage = provisionalPages.get(documentId);
			if (!lastProvisionalPage) {
				return;
			}
			const { message } = lastProvisionalPage;
			let tab;
			provisionalPages.delete(documentId);
			flushedSaveIds.add(message.saveId);
			setTimeout(() => flushedSaveIds.delete(message.saveId), FLUSHED_SAVE_ID_TTL);
			try {
				tab = await browser.tabs.get(lastProvisionalPage.tab.id);
				// eslint-disable-next-line no-unused-vars
			} catch (error) {
				tab = Object.assign({ removed: true }, lastProvisionalPage.tab);
			}
			try {
				await saveContent(message, tab);
			} catch (error) {
				console.error(error); // eslint-disable-line no-console
			}
		}, PROVISIONAL_SAVE_DELAY);
	}
}

function onTabUpdated(tabId) {
	delete pendingMessages[tabId];
}

async function onTabRemoved(tabId) {
	provisionalPages.forEach((provisionalPage, documentId) => {
		if (provisionalPage.tab.id == tabId) {
			flushProvisionalPage(documentId);
		}
	});
	const message = pendingMessages[tabId];
	if (message) {
		if (message.autoSaveRemove) {
			delete pendingMessages[tabId];
			await saveContent(message, message.tab);
		}
	} else {
		pendingMessages[tabId] = { removed: true };
	}
}

async function onTabDiscarded(tabId) {
	const message = pendingMessages[tabId];
	if (message) {
		delete pendingMessages[tabId];
		await saveContent(message, message.tab);
	} else {
		pendingMessages[tabId] = { discarded: true };
	}
}

async function onTabReplaced(addedTabId, removedTabId) {
	provisionalPages.forEach(provisionalPage => {
		if (provisionalPage.tab.id == removedTabId) {
			provisionalPage.tab.id = addedTabId;
		}
	});
	if (pendingMessages[removedTabId] && !pendingMessages[addedTabId]) {
		pendingMessages[addedTabId] = pendingMessages[removedTabId];
		delete pendingMessages[removedTabId];
		replacedTabIds[removedTabId] = addedTabId;
	}
}

async function onMessageExternal(message, currentTab) {
	if (message.method == "enableAutoSave") {
		const allTabsData = await tabsData.get(currentTab.id);
		allTabsData[currentTab.id].autoSave = message.enabled;
		await tabsData.set(allTabsData);
		ui.refreshTab(currentTab);
	}
	if (message.method == "isAutoSaveEnabled") {
		return autoSaveIsEnabled(currentTab);
	}
}

async function onInit(tab) {
	const [options, autoSaveEnabled] = await Promise.all([config.getOptions(tab.url, true), autoSaveIsEnabled(tab)]);
	if (options && ((options.autoSaveLoad || options.autoSaveLoadOrUnload) && autoSaveEnabled)) {
		business.saveTabs([tab], { autoSave: true });
	}
}

async function saveContent(message, tab) {
	const tabId = tab.id;
	const taskIdDefined = message.taskId !== undefined && message.taskId !== null;
	if (!message.autoSaveProvisional) {
		discardProvisionalPage(message);
	}
	if (taskIdDefined) {
		business.onSaveStart(message.taskId);
	}
	// the tab may already display another page: the options are those of the saved page
	const options = await config.getOptions(message.url || tab.url, true);
	if (options) {
		if (!tab.removed) {
			ui.onStart(tabId, 1, true);
		}
		options.content = message.content;
		options.url = message.url;
		options.frames = message.frames;
		options.canvases = message.canvases;
		options.fonts = message.fonts;
		options.stylesheets = message.stylesheets;
		options.images = message.images;
		options.posters = message.posters;
		options.videos = message.videos;
		options.usedFonts = message.usedFonts;
		options.shadowRoots = message.shadowRoots;
		options.referrer = message.referrer;
		options.worklets = message.worklets;
		options.adoptedStyleSheets = message.adoptedStyleSheets;
		options.visitDate = new Date(message.visitDate);
		options.backgroundTab = true;
		options.autoSave = true;
		options.incognito = tab.incognito;
		options.tabId = tabId;
		options.tabIndex = tab.index;
		let pageData;
		try {
			if (options.autoSaveExternalSave) {
				await companion.externalSave(options);
			} else {
				if (options.passReferrerOnError) {
					enableReferrerOnError();
				}
				options.tabId = tabId;
				pageData = await getPageData(options, { fetch }, null, null);
				let skipped;
				if (!options.saveToGDrive && !options.saveWithWebDAV && !options.saveWithMCP && !options.saveToGitHub && !options.saveToDropbox && !options.saveWithCompanion && !options.saveToRestFormApi && !options.saveToS3) {
					const testSkip = await downloads.testSkipSave(pageData.filename, options);
					skipped = testSkip.skipped;
					options.filenameConflictAction = testSkip.filenameConflictAction;
				}
				if (!skipped) {
					let { content, mimeType: type } = pageData;
					if (options.compressContent) {
						content = new Blob([new Uint8Array(content)], { type });
					}
					if (options.saveToGDrive) {
						if (!(content instanceof Blob)) {
							content = new Blob([content], { type });
						}
						await downloads.saveToGDrive(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, {
							forceWebAuthFlow: options.forceWebAuthFlow
						}, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveToDropbox) {
						if (!(content instanceof Blob)) {
							content = new Blob([content], { type });
						}
						await downloads.saveToDropbox(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveWithWebDAV) {
						await downloads.saveWithWebDAV(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, options.webDAVURL, options.webDAVUser, options.webDAVPassword, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveWithMCP) {
						await downloads.saveWithMCP(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, options.mcpServerUrl, options.mcpAuthToken, {
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveToGitHub) {
						await (await downloads.saveToGitHub(message.taskId, downloads.encodeSharpCharacter(pageData.filename), content, options.githubToken, options.githubUser, options.githubRepository, options.githubBranch, {
							filenameConflictAction: options.filenameConflictAction
						})).pushPromise;
					} else if (options.saveWithCompanion && !options.compressContent) {
						await companion.save({
							filename: pageData.filename,
							content: pageData.content,
							title: pageData.title,
							url: options.url,
							filenameConflictAction: options.filenameConflictAction
						});
					} else if (options.saveToRestFormApi) {
						await downloads.saveToRestFormApi(
							message.taskId,
							pageData.filename,
							content,
							options.url,
							options.saveToRestFormApiToken,
							options.saveToRestFormApiUrl,
							options.saveToRestFormApiFileFieldName,
							options.saveToRestFormApiUrlFieldName
						);
					} else if (options.saveToS3) {
						if (!(content instanceof Blob)) {
							content = new Blob([content], { type });
						}
						await downloads.saveToS3(
							message.taskId,
							pageData.filename,
							content,
							options.S3Domain,
							options.S3Region,
							options.S3Bucket,
							options.S3AccessKey,
							options.S3SecretKey,
							{ filenameConflictAction: options.filenameConflictAction }
						);
					} else {
						if (!(content instanceof Blob)) {
							content = new Blob([content], { type });
						}
						pageData.url = URL.createObjectURL(content);
						await downloads.downloadPage(pageData, options);
					}
					if (options.openSavedPage) {
						const createTabProperties = { active: true, url: "/src/ui/pages/viewer.html?compressed=true&blobURI=" + URL.createObjectURL(content), windowId: tab.windowId };
						const index = tab.index;
						try {
							await browser.tabs.get(tabId);
							createTabProperties.index = index + 1;
							// eslint-disable-next-line no-unused-vars
						} catch (error) {
							createTabProperties.index = index;
						}
						browser.tabs.create(createTabProperties);
					}
					if (pageData.hash) {
						await woleet.anchor(pageData.hash, options.woleetKey);
					}
				}
			}
		} finally {
			if (taskIdDefined) {
				business.onSaveEnd(message.taskId);
			} else if (options.autoClose && !tab.removed) {
				browser.tabs.remove(replacedTabIds[tabId] || tabId);
				delete replacedTabIds[tabId];
			}
			if (pageData && pageData.url) {
				URL.revokeObjectURL(pageData.url);
			}
			if (!tab.removed) {
				ui.onEnd(tabId, true);
			}
		}
	} else if (taskIdDefined) {
		business.onSaveEnd(message.taskId);
	}
}

async function fetch(url, options = {}) {
	const response = await fetchResource(url, options);
	return {
		status: response.status,
		headers: {
			get: name => response.headers[name]
		},
		arrayBuffer: () => response.arrayBuffer
	};
}