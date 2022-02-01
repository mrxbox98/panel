import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, ITerminalOptions } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SearchAddon } from 'xterm-addon-search';
import { SearchBarAddon } from 'xterm-addon-search-bar';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { ScrollDownHelperAddon } from '@/plugins/XtermScrollDownHelperAddon';
import SpinnerOverlay from '@/components/elements/SpinnerOverlay';
import { ServerContext } from '@/state/server';
import styled from 'styled-components/macro';
import { usePermissions } from '@/plugins/usePermissions';
import tw, { theme as th } from 'twin.macro';
import 'xterm/css/xterm.css';
import useEventListener from '@/plugins/useEventListener';
import { debounce } from 'debounce';
import { usePersistedState } from '@/plugins/usePersistedState';
import { SocketEvent, SocketRequest } from '@/components/server/events';

const theme = {
    background: th`colors.black`.toString(),
    cursor: 'transparent',
    black: th`colors.black`.toString(),
    red: '#E54B4B',
    green: '#9ECE58',
    yellow: '#FAED70',
    blue: '#396FE2',
    magenta: '#BB80B3',
    cyan: '#2DDAFD',
    white: '#d0d0d0',
    brightBlack: 'rgba(255, 255, 255, 0.2)',
    brightRed: '#FF5370',
    brightGreen: '#C3E88D',
    brightYellow: '#FFCB6B',
    brightBlue: '#82AAFF',
    brightMagenta: '#C792EA',
    brightCyan: '#89DDFF',
    brightWhite: '#ffffff',
    selection: '#FAF089',
};

const terminalProps: ITerminalOptions = {
    disableStdin: true,
    cursorStyle: 'underline',
    allowTransparency: true,
    fontSize: 12,
    fontFamily: 'Menlo, Monaco, Consolas, monospace',
    rows: 30,
    theme: theme,
};

const TerminalDiv = styled.div`
    &::-webkit-scrollbar {
        width: 8px;
    }

    &::-webkit-scrollbar-thumb {
        ${tw`bg-neutral-900`};
    }
`;

const CommandInput = styled.input`
    ${tw`text-sm transition-colors duration-150 px-2 bg-transparent border-0 border-b-2 border-transparent text-neutral-100 p-2 pl-0 w-full focus:ring-0`}
    &:focus {
        ${tw`border-cyan-700`};
    }
`;

export default () => {
    const TERMINAL_PRELUDE = '\u001b[1m\u001b[33mcontainer@pterodactyl~ \u001b[0m';
    const ref = useRef<HTMLDivElement>(null);
    const terminal = useMemo(() => new Terminal({ ...terminalProps }), []);
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const searchBar = new SearchBarAddon({ searchAddon });
    const webLinksAddon = new WebLinksAddon();
    const scrollDownHelperAddon = new ScrollDownHelperAddon();
    const { connected, instance } = ServerContext.useStoreState(state => state.socket);
    const [ canSendCommands ] = usePermissions([ 'control.console' ]);
    const serverId = ServerContext.useStoreState(state => state.server.data!.id);
    const isTransferring = ServerContext.useStoreState(state => state.server.data!.isTransferring);
    const [ history, setHistory ] = usePersistedState<string[]>(`${serverId}:command_history`, []);
    const [ historyIndex, setHistoryIndex ] = useState(-1);

    const handleConsoleOutput = (line: string, prelude = false) => terminal.writeln(
        (prelude ? TERMINAL_PRELUDE : '') + line.replace(/(?:\r\n|\r|\n)$/im, '') + '\u001b[0m',
    );

    const handleTransferStatus = (status: string) => {
        switch (status) {
            // Sent by either the source or target node if a failure occurs.
            case 'failure':
                terminal.writeln(TERMINAL_PRELUDE + 'Transfer has failed.\u001b[0m');
                return;

            // Sent by the source node whenever the server was archived successfully.
            case 'archive':
                terminal.writeln(TERMINAL_PRELUDE + 'Server has been archived successfully, attempting connection to target node..\u001b[0m');
        }
    };

    const handleDaemonErrorOutput = (line: string) => terminal.writeln(
        TERMINAL_PRELUDE + '\u001b[1m\u001b[41m' + line.replace(/(?:\r\n|\r|\n)$/im, '') + '\u001b[0m',
    );

    const handlePowerChangeEvent = (state: string) => terminal.writeln(
        TERMINAL_PRELUDE + 'Server marked as ' + state + '...\u001b[0m',
    );

    const handleCommandKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowUp') {
            const newIndex = Math.min(historyIndex + 1, history!.length - 1);

            setHistoryIndex(newIndex);
            e.currentTarget.value = history![newIndex] || '';

            // By default up arrow will also bring the cursor to the start of the line,
            // so we'll preventDefault to keep it at the end.
            e.preventDefault();
        }

        if (e.key === 'ArrowDown') {
            const newIndex = Math.max(historyIndex - 1, -1);

            setHistoryIndex(newIndex);
            e.currentTarget.value = history![newIndex] || '';
        }

        const command = e.currentTarget.value;
        if (e.key === 'Enter' && command.length > 0) {
            setHistory(prevHistory => [ command, ...prevHistory! ].slice(0, 32));
            setHistoryIndex(-1);

            instance && instance.send('send command', command);
            e.currentTarget.value = '';
        }
    };

    useEffect(() => {
        if (connected && ref.current && !terminal.element) {
            terminal.loadAddon(fitAddon);
            terminal.loadAddon(searchAddon);
            terminal.loadAddon(searchBar);
            terminal.loadAddon(webLinksAddon);
            terminal.loadAddon(scrollDownHelperAddon);

            terminal.open(ref.current);
            fitAddon.fit();

            // Add support for capturing keys
            terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                    document.execCommand('copy');
                    return false;
                } else if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                    e.preventDefault();
                    searchBar.show();
                    return false;
                } else if (e.key === 'Escape') {
                    searchBar.hidden();
                }
                return true;
            });
        }
    }, [ terminal, connected ]);

    useEventListener('resize', debounce(() => {
        if (terminal.element) {
            fitAddon.fit();
        }
    }, 100));

    useEffect(() => {
        const listeners: Record<string, (s: string) => void> = {
            [SocketEvent.STATUS]: handlePowerChangeEvent,
            [SocketEvent.CONSOLE_OUTPUT]: handleConsoleOutput,
            [SocketEvent.INSTALL_OUTPUT]: handleConsoleOutput,
            [SocketEvent.TRANSFER_LOGS]: handleConsoleOutput,
            [SocketEvent.TRANSFER_STATUS]: handleTransferStatus,
            [SocketEvent.DAEMON_MESSAGE]: line => handleConsoleOutput(line, true),
            [SocketEvent.DAEMON_ERROR]: handleDaemonErrorOutput,
        };

        if (connected && instance) {
            // Do not clear the console if the server is being transferred.
            if (!isTransferring) {
                terminal.clear();
            }

            Object.keys(listeners).forEach((key: string) => {
                instance.addListener(key, listeners[key]);
            });
            instance.send(SocketRequest.SEND_LOGS);
        }

        return () => {
            if (instance) {
                Object.keys(listeners).forEach((key: string) => {
                    instance.removeListener(key, listeners[key]);
                });
            }
        };
    }, [ connected, instance ]);

    function openConsole () {
        window.open(window.location.href + '/console', 'Server Console', 'height=1000,width=1500');
    }

    return (
        <div css={window.location.href.includes('/console') ? tw`text-xs font-mono relative w-full h-screen overflow-hidden` : tw`text-xs font-mono relative`}>
            <SpinnerOverlay visible={!connected} size={'large'} />
            <div
                css={[
                    tw`rounded-t p-2 bg-black w-full`,
                    !canSendCommands && tw`rounded-b`,
                ]}
                style={{ minHeight: '16rem' }}
            >
                <TerminalDiv style={window.location.href.includes('/console') ? { height: 'calc(100% - 54px)' } : {}} id={'terminal'} ref={ref} />
            </div>
            {canSendCommands &&
                <div css={tw`rounded-b bg-neutral-900 text-neutral-100 flex items-baseline`}>
                    <div css={tw`flex-shrink-0 p-2 font-bold`}>$</div>
                    <div style={{ width: '96%' }} css={tw`inline-block`}>
                        <CommandInput
                            type={'text'}
                            placeholder={'Type a command...'}
                            aria-label={'Console command input.'}
                            disabled={!instance || !connected}
                            onKeyDown={handleCommandKeyDown}
                        />
                    </div>
                    <button css={tw`m-auto mr-2 inline-block`} hidden={window.location.href.includes('/console')} onClick={openConsole}>
                        <svg xmlns="http://www.w3.org/2000/svg" css={tw`m-auto w-6 h-6`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                    </button>
                </div>
            }
        </div>
    );
};
