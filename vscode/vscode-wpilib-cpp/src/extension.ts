'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { IExternalAPI, getExternalAPIExpectedVersion, getExampleTemplateAPIExpectedVersion, getDeployDebugAPIExpectedVersion, getPreferencesAPIExpectedVersion } from './shared/externalapi';
import { DebugCommands, startDebugging } from './debug';
import { gradleRun, OutputPair } from './shared/gradle';
import * as path from 'path';
import { WpiLibHeaders } from './header_search';
import { CppGradleProperties, ExternalEditorConfig } from './cpp_gradle_properties';
import { CppVsCodeProperties } from './cpp_vscode_properties';
import { CppPreferences } from './cpp_preferences';
import { Examples } from './shared/examples';
import { Templates } from './shared/templates';

interface DebuggerParse {
    port: string;
    ip: string;
}

function parseGradleOutput(output: OutputPair): DebuggerParse {
    const ret: DebuggerParse = {
        port: '',
        ip: ''
    };

    const results = output.stdout.split('\n');
    for (const r of results) {
        if (r.indexOf('DEBUGGING ACTIVE ON PORT ') >= 0) {
            ret.port = r.substring(27, r.indexOf('!')).trim();
        }
        if (r.indexOf('Using address ') >= 0) {
            ret.ip = r.substring(14, r.indexOf(' for')).trim();
            ret.ip = ret.ip.split(':')[0];
        }
    }

    return ret;
}



// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "vscode-wpilib-cpp" is now active!');

    const extensionResourceLocation = path.join(context.extensionPath, 'resources');

    const coreExtension = vscode.extensions.getExtension<IExternalAPI>('wpifirst.vscode-wpilib-core');
    if (coreExtension === undefined) {
        vscode.window.showErrorMessage('Could not find core library');
        return;
    }

    let allowDebug = true;

    const promises = [];

    const cppExtension = vscode.extensions.getExtension('ms-vscode.cpptools');
    if (cppExtension === undefined) {
        vscode.window.showInformationMessage('Could not find cpptools C++ extension. Debugging is disabled.');
        allowDebug = false;
    } else if (!cppExtension.isActive) {
        promises.push(cppExtension.activate());
    }

    if (!coreExtension.isActive) {
        promises.push(coreExtension.activate());
    }

    if (promises.length > 0) {
        await Promise.all(promises);
    }

    const coreExports: IExternalAPI = coreExtension.exports;

    const baseValid = coreExports.getVersion() === getExternalAPIExpectedVersion();

    if (!baseValid) {
        vscode.window.showErrorMessage('Extension out of date with core extension. Please update');
        return;
    }

    const preferences = coreExports.getPreferencesAPI();
    const debugDeploy = coreExports.getDeployDebugAPI();
    const exampleTemplate = coreExports.getExampleTemplateAPI();

    let exampleTemplateValid = false;
    let debugDeployValid = false;
    let preferencesValid = false;

    if (exampleTemplate !== undefined) {
        exampleTemplateValid = exampleTemplate.getVersion() === getExampleTemplateAPIExpectedVersion();
    }

    if (debugDeploy !== undefined) {
        debugDeployValid = debugDeploy.getVersion() === getDeployDebugAPIExpectedVersion();
    }

    if (preferences !== undefined) {
        preferencesValid = preferences.getVersion() === getPreferencesAPIExpectedVersion();
    }

    if (debugDeployValid === true && preferencesValid === true && preferences !== undefined && debugDeploy !== undefined) {
        // Setup debug and deploy
        const workspaces = vscode.workspace.workspaceFolders;

        const gradleProps: CppGradleProperties[] = [];
        const headerFinders: WpiLibHeaders[] = [];
        const cppProps: CppVsCodeProperties[] = [];
        const cppPrefs: CppPreferences[] = [];

        const gradleChannel = vscode.window.createOutputChannel('gradleCpp');

        if (workspaces !== undefined) {
            // Create new header finders for every workspace
            for (const w of workspaces) {
                const p = preferences.getPreferences(w);
                if (p === undefined) {
                    console.log('Preferences without workspace?');
                    continue;
                }
                const cpr = new CppPreferences(w);
                const gp = new CppGradleProperties(w, gradleChannel, cpr);
                await gp.forceReparse();
                const wh = new WpiLibHeaders(gp);
                const cp = new CppVsCodeProperties(w, gp, cpr);
                cppPrefs.push(cpr);
                gradleProps.push(gp);
                headerFinders.push(wh);
                cppProps.push(cp);
            }
        }

        // On a change in workspace folders, redo all header finders
        preferences.onDidPreferencesFolderChanged(async (changed) => {
            // Nuke and reset
            // TODO: Remove existing header finders from the extension context
            for (const p of headerFinders) {
                p.dispose();
            }
            for (const p of gradleProps) {
                p.dispose();
            }
            for (const p of cppPrefs) {
                p.dispose();
            }
            for (const p of cppProps) {
                p.dispose();
            }

            for (const c of changed) {
                const cpr = new CppPreferences(c.workspace);
                const gp = new CppGradleProperties(c.workspace, gradleChannel, cpr);
                await gp.forceReparse();
                const wh = new WpiLibHeaders(gp);
                const cp = new CppVsCodeProperties(c.workspace, gp, cpr);
                cppPrefs.push(cpr);
                gradleProps.push(gp);
                headerFinders.push(wh);
                cppProps.push(cp);
            }

            context.subscriptions.push(...headerFinders);
            context.subscriptions.push(...gradleProps);
            context.subscriptions.push(...cppProps);
            context.subscriptions.push(...cppPrefs);
        });

        context.subscriptions.push(...headerFinders);
        context.subscriptions.push(...gradleProps);
        context.subscriptions.push(...cppProps);
        context.subscriptions.push(...cppPrefs);

        debugDeploy.addLanguageChoice('cpp');

        debugDeploy.registerCodeDeploy({
            async getIsCurrentlyValid(workspace: vscode.WorkspaceFolder): Promise<boolean> {
                const prefs = await preferences.getPreferences(workspace);
                if (prefs === undefined) {
                    console.log('Preferences without workspace?');
                    return false;
                }
                const currentLanguage = prefs.getCurrentLanguage();
                return currentLanguage === 'none' || currentLanguage === 'cpp';
            },
            async runDeployer(teamNumber: number, workspace: vscode.WorkspaceFolder): Promise<boolean> {
                const command = 'deploy --offline -PteamNumber=' + teamNumber;
                gradleChannel.clear();
                gradleChannel.show();
                if (workspace === undefined) {
                    vscode.window.showInformationMessage('No workspace selected');
                    return false;
                }
                const result = await gradleRun(command, workspace.uri.fsPath, gradleChannel);
                console.log(result);
                return true;
            },
            getDisplayName(): string {
                return 'cpp';
            },
            getDescription(): string {
                return 'C++ Deployment';
            }
        });

        if (allowDebug) {
            debugDeploy.registerCodeDebug({
                async getIsCurrentlyValid(workspace: vscode.WorkspaceFolder): Promise<boolean> {
                    const prefs = await preferences.getPreferences(workspace);
                    if (prefs === undefined) {
                        console.log('Preferences without workspace?');
                        return false;
                    }
                    const currentLanguage = prefs.getCurrentLanguage();
                    return currentLanguage === 'none' || currentLanguage === 'cpp';
                },
                async runDeployer(teamNumber: number, workspace: vscode.WorkspaceFolder): Promise<boolean> {
                    const command = 'deploy --offline -PdebugMode -PteamNumber=' + teamNumber;
                    gradleChannel.clear();
                    gradleChannel.show();
                    if (workspace === undefined) {
                        vscode.window.showInformationMessage('No workspace selected');
                        return false;
                    }
                    const result = await gradleRun(command, workspace.uri.fsPath, gradleChannel);

                    const parsed = parseGradleOutput(result);

                    let cfg: ExternalEditorConfig | undefined = undefined;

                    for (const p of gradleProps) {
                        if (p.workspace.uri === workspace.uri) {
                            await p.forceReparse();
                            cfg = p.getLastConfig();
                        }
                    }

                    if (cfg === undefined) {
                        console.log('debugging failed');
                        vscode.window.showInformationMessage('Debugging failed');
                        return false;
                    }


                    let soPath = '';

                    for (const p of cfg.component.libSharedFilePaths) {
                        soPath += path.dirname(p) + ';';
                    }

                    soPath = soPath.substring(0, soPath.length - 1);

                    let sysroot = '';

                    if (cfg.compiler.sysroot !== null) {
                        sysroot = cfg.compiler.sysroot;
                    }

                    const config: DebugCommands = {
                        serverAddress: parsed.ip,
                        serverPort: parsed.port,
                        sysroot: sysroot,
                        executablePath: cfg.component.launchfile,
                        workspace: workspace,
                        soLibPath: soPath,
                        additionalCommands: []
                    };

                    let cppPref: CppPreferences | undefined = undefined;

                    for (const c of cppPrefs) {
                        if (c.workspace.uri === workspace.uri) {
                            cppPref = c;
                        }
                    }

                    if (cppPref !== undefined) {
                        config.additionalCommands = cppPref.getAdditionalDebugCommands();
                    }

                    await startDebugging(config);

                    console.log(result);
                    return true;
                },
                getDisplayName(): string {
                    return 'cpp';
                },
                getDescription(): string {
                    return 'C++ Debugging';
                }
            });
        }

        context.subscriptions.push(vscode.commands.registerCommand('wpilibcpp.refreshProperties', () => {
            for (const c of gradleProps) {
                c.runGradleRefresh();
            }
        }));
    } else {
        vscode.window.showInformationMessage('Cpp does not match Core. Update');
        console.log('Cpp debug/deploy extension out of date');
        context.subscriptions.push(vscode.commands.registerCommand('wpilibcpp.refreshProperties', () => {
            vscode.window.showInformationMessage('Refresh not currently valid');
        }));
    }

    if (exampleTemplateValid === true && exampleTemplate !== undefined) {
        // Setup examples and template
        const examples: Examples = new Examples(extensionResourceLocation, 'cpp', exampleTemplate);
        context.subscriptions.push(examples);
        const templates: Templates = new Templates(extensionResourceLocation, 'cpp', exampleTemplate);
        context.subscriptions.push(templates);

    } else {
        vscode.window.showInformationMessage('Cpp examples and templates do not match Core. Update');
        console.log('Cpp examples and templates extension out of date');
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
}