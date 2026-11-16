// The kinds of media the app knows about. `type` matches media_files.media_type
// on the server; `slug` is the URL segment (/photo, /projects/:id/photo/:mediaId).
// Adding the photo or video annotator: build its page, set available: true,
// and route it in App.jsx (the coming-soon routes mark the spots).
export const MEDIA_TYPES = [
  { type: 'audio', slug: 'audio', label: 'Audio', icon: '♪', available: true },
  { type: 'image', slug: 'photo', label: 'Photo', icon: '▣', available: false },
  { type: 'video', slug: 'video', label: 'Video', icon: '▶', available: false },
];

export const mediaTypeInfo = (type) => MEDIA_TYPES.find(m => m.type === type) || MEDIA_TYPES[0];

export const mediaFilePath = (projectId, file) =>
  `/projects/${projectId}/${mediaTypeInfo(file.media_type).slug}/${file.id}`;
