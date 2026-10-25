import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { mediaTypeInfo } from '../mediaTypes';
import './pages.css';

// Placeholder for the photo and video annotators (media_type image/video).
export default function ComingSoonPage({ type }) {
  const { projectId } = useParams();
  const info = mediaTypeInfo(type);
  return (
    <div className="page">
      <div className="empty-state coming-soon">
        <div className="coming-soon-icon">{info.icon}</div>
        <h2>{info.label} annotator — coming soon</h2>
        <p>
          Projects can already hold {type === 'image' ? 'photos' : 'videos'} alongside audio, and annotations
          have room for {type === 'image' ? 'boxes and polygons' : 'frame ranges and regions'}; the annotator itself
          isn't built yet. For now, the <Link to="/audio">audio annotator</Link> is available.
        </p>
        {projectId && <Link className="btn btn-ghost" to={`/projects/${projectId}`}>Back to project</Link>}
      </div>
    </div>
  );
}
