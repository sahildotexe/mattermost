// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {ChangeEvent, ClipboardEventHandler, FocusEventHandler, MouseEvent} from 'react';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FormattedMessage, defineMessages, useIntl} from 'react-intl';
import {useDispatch, useSelector} from 'react-redux';
import styled from 'styled-components';

import {PencilOutlineIcon} from '@mattermost/compass-icons/components';
import {GenericModal} from '@mattermost/components';
import type {ChannelBookmark, ChannelBookmarkCreate, ChannelBookmarkPatch} from '@mattermost/types/channel_bookmarks';
import type {FileInfo} from '@mattermost/types/files';

import {debounce} from 'mattermost-redux/actions/helpers';
import {Client4} from 'mattermost-redux/client';
import {getFile} from 'mattermost-redux/selectors/entities/files';
import {getConfig} from 'mattermost-redux/selectors/entities/general';
import type {ActionResult} from 'mattermost-redux/types/actions';

import type {UploadFile} from 'actions/file_actions';
import {uploadFile} from 'actions/file_actions';

import FileAttachment from 'components/file_attachment';
import type {FilePreviewInfo} from 'components/file_preview/file_preview';
import FileProgressPreview from 'components/file_preview/file_progress_preview';
import Input from 'components/widgets/inputs/input/input';
import LoadingSpinner from 'components/widgets/loading/loading_spinner';

import Constants from 'utils/constants';
import {isKeyPressed} from 'utils/keyboard';
import {isValidUrl, parseLink} from 'utils/url';
import {generateId} from 'utils/utils';

import type {GlobalState} from 'types/store';

import './bookmark_create_modal.scss';

import CreateModalNameInput from './create_modal_name_input';
import {useCanGetLinkPreviews, useCanUploadFiles} from './utils';

type Props = {
    channelId: string;
    bookmarkType?: ChannelBookmark['type'];
    file?: File;
    onExited: () => void;
    onHide: () => void;
} & ({
    bookmark: ChannelBookmark;
    onConfirm: (data: ChannelBookmarkPatch) => Promise<ActionResult<boolean, any>> | ActionResult<boolean, any>;
} | {
    bookmark?: never;
    onConfirm: (data: ChannelBookmarkCreate) => Promise<ActionResult<boolean, any>> | ActionResult<boolean, any>;
});

function validHttpUrl(input: string) {
    const val = parseLink(input);

    if (!val || !isValidUrl(val)) {
        return null;
    }

    let url;
    try {
        url = new URL(val);
    } catch {
        return null;
    }

    return url;
}

function ChannelBookmarkCreateModal({
    bookmark,
    bookmarkType,
    file: promptedFile,
    channelId,
    onExited,
    onConfirm,
    onHide,
}: Props) {
    const {formatMessage} = useIntl();
    const dispatch = useDispatch();

    // common
    const type = bookmark?.type ?? bookmarkType ?? 'link';
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [emoji, setEmoji] = useState(bookmark?.emoji ?? '');
    const [displayName, setDisplayName] = useState<string | undefined>(bookmark?.display_name);
    const [parsedDisplayName, setParsedDisplayName] = useState<string | undefined>();
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');

    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        if (isKeyPressed(event, Constants.KeyCodes.ESCAPE) && !showEmojiPicker) {
            onHide();
        }
    }, [showEmojiPicker, onHide]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [handleKeyDown]);

    // type === 'link'
    const [linkInputValue, setLinkInputValue] = useState(bookmark?.link_url ?? '');
    const [link, setLinkImmediately] = useState(linkInputValue);
    const [linkError, setLinkError] = useState('');
    const [icon, setIcon] = useState(bookmark?.image_url);
    const [isLoadingOpenGraphMetaLink, setIsLoadingOpenGraphMetaLink] = useState('');
    const openGraphRequestAbortController = useRef<AbortController>();
    const canUseLinkPreviews = useCanGetLinkPreviews();

    const handleLinkChange = useCallback(({target: {value}}: ChangeEvent<HTMLInputElement>) => {
        setLinkInputValue(value);
        setLink(value);
    }, []);

    const setLink = debounce((val: string) => {
        setLinkImmediately(val);
    }, 250);

    const handleLinkBlur: FocusEventHandler<HTMLInputElement> = useCallback(({target: {value}}) => {
        setLinkImmediately(value);
    }, []);

    const handleLinkPasted: ClipboardEventHandler<HTMLInputElement> = useCallback(({clipboardData}) => {
        setLinkImmediately(clipboardData.getData('text/plain'));
    }, []);

    const resetParsed = () => {
        setParsedDisplayName(link || '');
        setIcon('');
    };

    useEffect(() => {
        if (link === bookmark?.link_url) {
            return;
        }

        const url = validHttpUrl(link);

        (async () => {
            resetParsed();

            if (!url) {
                return;
            }

            if (!canUseLinkPreviews) {
                setParsedDisplayName(link);
                return;
            }

            try {
                openGraphRequestAbortController?.current?.abort('stale request');
                openGraphRequestAbortController.current = new AbortController();
                setIsLoadingOpenGraphMetaLink(link);

                const {title, images} = await Client4.fetchChannelBookmarkOpenGraph(channelId, url.toString(), openGraphRequestAbortController.current.signal);

                setParsedDisplayName(title || link);
                const favicon = images?.find(({type}) => type === 'image/x-mm-icon');
                setIcon(favicon?.secure_url || favicon?.url || '');
                setLinkError('');
            } catch (err) {
                if (err.server_error_id === 'api.context.invalid_url_param.app_error') {
                    setLinkError(formatMessage(msg.linkInvalid));
                }
                resetParsed();
            } finally {
                setIsLoadingOpenGraphMetaLink((currentLink) => {
                    if (currentLink === link) {
                        return '';
                    }
                    return currentLink;
                });
            }
        })();
    }, [link, bookmark?.link_url, channelId]);

    // type === 'file'
    const canUploadFiles = useCanUploadFiles();
    const [pendingFile, setPendingFile] = useState<FilePreviewInfo | null>();
    const [fileError, setFileError] = useState('');
    const [fileId, setFileId] = useState(bookmark?.file_id);
    const uploadRequestRef = useRef<XMLHttpRequest>();
    const fileInfo: FileInfo | undefined = useSelector((state: GlobalState) => (fileId && getFile(state, fileId)) || undefined);

    const maxFileSize = useSelector((state: GlobalState) => {
        const config = getConfig(state);
        return parseInt(config.MaxFileSize || '', 10);
    });
    const maxFileSizeMB = maxFileSize / 1048576;

    const handleEditFileClick = (e: MouseEvent<HTMLDivElement>) => {
        const innerClick = document.querySelector(`
            .channel-bookmarks-create-modal .post-image__download a,
            .channel-bookmarks-create-modal a.file-preview__remove
        `);
        if (
            innerClick === e.target ||
            innerClick?.contains(e.target as HTMLElement)
        ) {
            return;
        }

        fileInputRef.current?.click();
    };

    const handleFileChanged = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) {
            return;
        }

        doUploadFile(file);
    }, []);

    const handleFileRemove = () => {
        setPendingFile(null);
        setFileId(bookmark?.file_id);
        setParsedDisplayName(undefined);
        uploadRequestRef.current?.abort();
    };

    const fileInputRef = useRef<HTMLInputElement>(null);
    const fileInput = (
        <input
            type='file'
            id='bookmark-create-file-input'
            className='bookmark-create-file-input'
            ref={fileInputRef}
            onChange={handleFileChanged}
        />
    );

    const onProgress: UploadFile['onProgress'] = (preview) => {
        setPendingFile(preview);
    };
    const onSuccess: UploadFile['onSuccess'] = ({file_infos: fileInfos}) => {
        setPendingFile(null);
        const newFile: FileInfo = fileInfos?.[0];
        if (newFile) {
            setFileId(newFile.id);
        }
        setFileError('');
    };
    const onError: UploadFile['onError'] = () => {
        setPendingFile(null);
        setFileError(formatMessage({id: 'file_upload.generic_error_file', defaultMessage: 'There was a problem uploading your file.'}));
    };

    const displayNameValue = displayName || parsedDisplayName || (type === 'file' ? fileInfo?.name : bookmark?.link_url) || '';

    const doUploadFile = (file: File) => {
        setPendingFile(null);
        setFileId('');

        if (file.size > maxFileSize) {
            setFileError(formatMessage({
                id: 'file_upload.fileAbove',
                defaultMessage: 'File above {max}MB could not be uploaded: {filename}',
            }, {max: maxFileSizeMB, filename: file.name}));

            return;
        }

        if (file.size === 0) {
            setFileError(formatMessage({
                id: 'file_upload.zeroBytesFile',
                defaultMessage: 'You are uploading an empty file: {filename}',
            }, {filename: file.name}));

            return;
        }

        setFileError('');
        if (displayNameValue === fileInfo?.name) {
            setDisplayName(file.name);
        }
        setParsedDisplayName(file.name);

        const clientId = generateId();

        uploadRequestRef.current = dispatch(uploadFile({
            file,
            name: file.name,
            type: file.type,
            rootId: '',
            channelId,
            clientId,
            onProgress,
            onSuccess,
            onError,
        }, true)) as unknown as XMLHttpRequest;
    };

    useEffect(() => {
        if (promptedFile) {
            doUploadFile(promptedFile);
        }
    }, [promptedFile]);

    const handleOnExited = useCallback(() => {
        uploadRequestRef.current?.abort();
        onExited?.();
    }, [onExited]);

    // controls logic
    const hasChanges = (() => {
        if (displayNameValue !== bookmark?.display_name) {
            return true;
        }

        if ((emoji || bookmark?.emoji) && emoji !== bookmark?.emoji) {
            return true;
        }

        if (type === 'file') {
            if (fileId && fileId !== bookmark?.file_id) {
                return true;
            }
        }

        if (type === 'link') {
            return Boolean(link && link !== bookmark?.link_url);
        }

        return false;
    })();
    const isValid = (() => {
        if (type === 'link') {
            if (!link || linkError) {
                return false;
            }
        }

        if (type === 'file') {
            if (!fileInfo || !displayNameValue || fileError) {
                return false;
            }
        }

        return true;
    })();
    const showControls = type === 'file' || (isValid || bookmark);

    const cancel = useCallback(() => {
        if (type === 'file') {
            uploadRequestRef.current?.abort();
        }
    }, [type]);

    const confirm = useCallback(async () => {
        setSaving(true);
        if (type === 'link') {
            const url = validHttpUrl(link);

            if (!url) {
                setSaveError(formatMessage(msg.linkInvalid));
                return;
            }

            let validLink = url.toString();

            if (validLink.endsWith('/')) {
                validLink = validLink.slice(0, -1);
            }

            const {data: success} = await onConfirm({
                image_url: icon,
                link_url: validLink,
                emoji,
                display_name: displayNameValue,
                type: 'link',
            });

            setSaving(false);

            if (success) {
                setSaveError('');
                onHide();
            } else {
                setSaveError(formatMessage(msg.saveError));
            }
        } else if (fileInfo) {
            const {data: success} = await onConfirm({
                file_id: fileInfo.id,
                display_name: displayNameValue,
                type: 'file',
                emoji,
            });

            if (success) {
                setSaveError('');
                onHide();
            } else {
                setSaveError(formatMessage(msg.saveError));
            }
        }
    }, [type, link, onConfirm, onHide, fileInfo, displayNameValue, emoji, icon]);

    const confirmDisabled = saving || !isValid || !hasChanges;

    return (
        <GenericModal
            enforceFocus={!showEmojiPicker}
            keyboardEscape={false}
            className='channel-bookmarks-create-modal'
            modalHeaderText={formatMessage(bookmark ? msg.editHeading : msg.heading)}
            confirmButtonText={formatMessage(bookmark ? msg.saveText : msg.addBookmarkText)}
            handleCancel={(showControls && cancel) || undefined}
            handleConfirm={(showControls && confirm) || undefined}
            handleEnterKeyPress={(!confirmDisabled && confirm) || undefined}
            onExited={handleOnExited}
            compassDesign={true}
            isConfirmDisabled={confirmDisabled}
            autoCloseOnConfirmButton={false}
            errorText={saveError}
        >
            <>
                {type === 'link' ? (
                    <Input
                        type='text'
                        name='bookmark-link'
                        containerClassName='linkInput'
                        placeholder={formatMessage(msg.linkPlaceholder)}
                        onChange={handleLinkChange}
                        onBlur={handleLinkBlur}
                        onPaste={handleLinkPasted}
                        value={linkInputValue}
                        data-testid='linkInput'
                        autoFocus={true}
                        addon={isLoadingOpenGraphMetaLink ? <LoadingSpinner/> : undefined}
                        customMessage={linkError ? {type: 'error', value: linkError} : {value: formatMessage(msg.linkInfoMessage)}}
                    />
                ) : (
                    <>
                        <FieldLabel>
                            <FormattedMessage
                                id='channel_bookmarks.create.file_input.label'
                                defaultMessage='Attachment'
                            />
                        </FieldLabel>
                        <FileInputContainer
                            tabIndex={0}
                            role='button'
                            disabled={!canUploadFiles}
                            onClick={(canUploadFiles && handleEditFileClick) || undefined}
                        >
                            {!pendingFile && fileInfo && (
                                <FileItemContainer>
                                    <FileAttachment
                                        key={fileInfo.id}
                                        fileInfo={fileInfo}
                                        index={0}
                                    />
                                </FileItemContainer>
                            )}
                            {pendingFile && (
                                <FileProgressPreview
                                    key={pendingFile.clientId}
                                    clientId={pendingFile.clientId}
                                    fileInfo={pendingFile}
                                    handleRemove={handleFileRemove}
                                />
                            )}
                            {!fileInfo && !pendingFile && (
                                <div className='file-preview__container empty'/>
                            )}
                            <VisualButton>
                                <PencilOutlineIcon size={24}/>
                                {formatMessage(msg.fileInputEdit)}
                            </VisualButton>
                            {fileInput}
                        </FileInputContainer>
                        {fileError && (
                            <div className='Input___customMessage Input___error'>
                                <i className='icon error icon-alert-circle-outline'/>
                                <span>{fileError}</span>
                            </div>
                        )}
                    </>

                )}

                {showControls && (
                    <TitleWrapper>
                        <FieldLabel>
                            <FormattedMessage
                                id='channel_bookmarks.create.title_input.label'
                                defaultMessage='Title'
                            />
                        </FieldLabel>
                        <CreateModalNameInput
                            type={type}
                            imageUrl={icon}
                            fileInfo={pendingFile || fileInfo}
                            emoji={emoji}
                            setEmoji={setEmoji}
                            displayName={displayName}
                            placeholder={displayNameValue}
                            setDisplayName={setDisplayName}
                            onAddCustomEmojiClick={onHide}
                            showEmojiPicker={showEmojiPicker}
                            setShowEmojiPicker={setShowEmojiPicker}
                        />
                    </TitleWrapper>
                )}
            </>
        </GenericModal>
    );
}

export default ChannelBookmarkCreateModal;

const TitleWrapper = styled.div`
    margin-top: 20px;
`;

const FieldLabel = styled.span`
    display: inline-block;
    margin-bottom: 8px;
    font-family: Open Sans;
    font-size: 14px;
    line-height: 16px;
    font-style: normal;
    font-weight: 600;
    line-height: 20px;
`;

const VisualButton = styled.div`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px 24px;
    color: rgba(var(--center-channel-color-rgb), 0.56);
    font-size: 11px;
    font-weight: 600;
    font-family: Open Sans;
`;

const FileInputContainer = styled.div`
    display: block;
    background: rgba(var(--center-channel-color-rgb), 0.04);
    padding: 12px;
    border-radius: 8px;
    display: flex;

    &:hover:not([disabled]) {
        background: rgba(var(--center-channel-color-rgb), 0.08);
        color: rgba(var(--center-channel-color-rgb), 0.72);
        cursor: pointer;
    }

    &:disabled {
        cursor: default;
        ${VisualButton} {
            opacity: 0.4;
        }
    }

    input[type="file"] {
        opacity: 0;
        width: 0;
        height: 0;
    }

    .file-preview__container,
    .file-preview {
        width: auto;
        height: auto;
        flex: 1 1 auto;
        padding: 0;

        &.empty {
            border: 2px dashed rgba(var(--center-channel-color-rgb), 0.16);
            border-radius : 4px;
        }

        .post-image__column {
            width: 100%;
            margin: 0;
        }
    }
`;

const FileItemContainer = styled.div`
    display: flex;
    flex: 1 1 auto;

    > div {
        width: 100%;
        margin: 0;
    }
`;

const msg = defineMessages({
    heading: {id: 'channel_bookmarks.create.title', defaultMessage: 'Add a bookmark'},
    editHeading: {id: 'channel_bookmarks.create.edit.title', defaultMessage: 'Edit bookmark'},
    linkPlaceholder: {id: 'channel_bookmarks.create.link_placeholder', defaultMessage: 'Link'},
    linkInfoMessage: {id: 'channel_bookmarks.create.link_info', defaultMessage: 'Add a link to any post, file, or any external link'},
    addBookmarkText: {id: 'channel_bookmarks.create.confirm_add.button', defaultMessage: 'Add bookmark'},
    saveText: {id: 'channel_bookmarks.create.confirm_save.button', defaultMessage: 'Save bookmark'},
    fileInputEdit: {id: 'channel_bookmarks.create.file_input.edit', defaultMessage: 'Edit'},
    linkInvalid: {id: 'channel_bookmarks.create.error.invalid_url', defaultMessage: 'Please enter a valid link'},
    saveError: {id: 'channel_bookmarks.create.error.generic_save', defaultMessage: 'There was an error trying to save the bookmark.'},
});
