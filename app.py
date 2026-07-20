import pickle
import json
import time
import sqlite3
import os
import shutil
import numpy as np
from flask import Flask, render_template, jsonify, request, send_file
from dotenv import load_dotenv

# Trigger deploy with updated author account
load_dotenv()

app = Flask(__name__)

# ── Database Configuration ────────────────────────────────────────────────────
DATABASE_URL = os.environ.get('DATABASE_URL')
IS_POSTGRES = DATABASE_URL is not None and DATABASE_URL.startswith('postgres')

_repo_dir = os.path.dirname(os.path.abspath(__file__))

if not IS_POSTGRES:
    if os.environ.get('VERCEL'):
        DB_PATH = '/tmp/dataset.db'
        _repo_db = os.path.join(_repo_dir, 'dataset.db')
        if os.path.exists(_repo_db) and not os.path.exists(DB_PATH):
            try:
                shutil.copy(_repo_db, DB_PATH)
            except Exception as _e:
                print(f"[DB] ⚠ Failed to copy dataset.db to /tmp: {_e}")
    else:
        DB_PATH = os.path.join(_repo_dir, 'dataset.db')
else:
    DB_PATH = None

def get_db_connection():
    if IS_POSTGRES:
        import psycopg2
        # Handle the common "postgres://" vs "postgresql://" issue for some libraries
        url = DATABASE_URL.replace("postgres://", "postgresql://", 1)
        conn = psycopg2.connect(url)
        return conn
    else:
        conn = sqlite3.connect(DB_PATH)
        return conn

def execute_query(conn, query, params=(), commit=False):
    if IS_POSTGRES:
        # Convert SQLite '?' placeholders to Postgres '%s'
        query = query.replace('?', '%s')
        # Postgres 'datetime('now','localtime')' is different
        query = query.replace("datetime('now','localtime')", "NOW()")
        # Postgres 'AUTOINCREMENT' is 'SERIAL' or handled by IDENTITY
    
    cur = conn.cursor()
    cur.execute(query, params)
    
    result = None
    if not commit:
        try:
            result = cur.fetchall()
        except:
            pass
    
    lastrowid = None
    if IS_POSTGRES:
        if "INSERT" in query.upper():
            try:
                cur.execute("SELECT lastval()")
                lastrowid = cur.fetchone()[0]
            except:
                pass
    else:
        lastrowid = cur.lastrowid
        
    if commit:
        conn.commit()
    
    return result, lastrowid

def init_db():
    conn = get_db_connection()
    try:
        if IS_POSTGRES:
            execute_query(conn, """
                CREATE TABLE IF NOT EXISTS samples (
                    id           SERIAL PRIMARY KEY,
                    label        TEXT    NOT NULL,
                    mode         TEXT    NOT NULL DEFAULT 'ASL',
                    capture_type TEXT    NOT NULL DEFAULT 'gesture',
                    landmarks    TEXT    NOT NULL,
                    frame_count  INTEGER NOT NULL DEFAULT 1,
                    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """, commit=True)
            execute_query(conn, """
                CREATE TABLE IF NOT EXISTS trained_models (
                    id           SERIAL PRIMARY KEY,
                    name         TEXT    NOT NULL UNIQUE,
                    data         BYTEA   NOT NULL,
                    updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """, commit=True)
            execute_query(conn, """
                CREATE TABLE IF NOT EXISTS hidden_models (
                    name TEXT PRIMARY KEY
                )
            """, commit=True)
        else:
            execute_query(conn, """
                CREATE TABLE IF NOT EXISTS samples (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    label        TEXT    NOT NULL,
                    mode         TEXT    NOT NULL DEFAULT 'ASL',
                    capture_type TEXT    NOT NULL DEFAULT 'gesture',
                    landmarks    TEXT    NOT NULL,
                    frame_count  INTEGER NOT NULL DEFAULT 1,
                    created_at   TEXT    NOT NULL
                                 DEFAULT (datetime('now','localtime'))
                )
            """, commit=True)
            execute_query(conn, """
                CREATE TABLE IF NOT EXISTS trained_models (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    name         TEXT    NOT NULL UNIQUE,
                    data         BLOB    NOT NULL,
                    updated_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                )
            """, commit=True)
            execute_query(conn, """
                CREATE TABLE IF NOT EXISTS hidden_models (
                    name TEXT PRIMARY KEY
                )
            """, commit=True)
    finally:
        conn.close()

init_db()

try:
    from sklearn.ensemble import RandomForestClassifier
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False

# ── Dataset Classifier ──────────────────────────────────────────────────────────


class SignClassifier:
    def __init__(self, db_path):
        self.db_path = db_path
        self.model_name = 'gesture_model.pkl'
        if os.environ.get('VERCEL'):
            self.model_path = os.path.join('/tmp', self.model_name)
        else:
            self.model_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), self.model_name)

        self.samples = []  # List of {label, type, landmarks_norm}
        self.model = None
        self.classes = []
        self.load_model()
        self.reload()

    def load_model(self):
        """Try to load a pre-trained scikit-learn model from DB, then fallback to disk."""
        # 1. Try loading from Database
        try:
            conn = get_db_connection()
            try:
                # Use standard SQL for both
                rows, _ = execute_query(conn, "SELECT data FROM trained_models WHERE name = ?", (self.model_name,))
                if rows:
                    model_data = rows[0][0]
                    # Support both bytes (Postgres) and buffer/bytes (SQLite)
                    if isinstance(model_data, (bytes, bytearray)):
                        data = pickle.loads(model_data)
                        self.model = data['model']
                        self.classes = data['classes']
                        print(f"[Classifier] ★ LOADED FROM DATABASE: {self.model_name}")
                        return
            finally:
                conn.close()
        except Exception as e:
            print(f"[Classifier] ⚠ Error loading model from DB: {e}")

        # 2. Fallback to Disk
        if os.path.exists(self.model_path):
            try:
                with open(self.model_path, 'rb') as f:
                    data = pickle.load(f)
                    self.model = data['model']
                    self.classes = data['classes']
                print(
                    f"[Classifier] ★ LOADED FROM DISK: {os.path.basename(self.model_path)} with classes: {self.classes}")
            except Exception as e:
                print(f"[Classifier] ⚠ Error loading model file: {e}")
        else:
            print(f"[Classifier] ⚠ Model file not found on disk: {self.model_path}")

    def reload(self):
        """Load and pre-process all samples from the database for KNN fallback or training."""
        try:
            conn = get_db_connection()
            try:
                rows, _ = execute_query(conn, "SELECT label, capture_type, landmarks FROM samples")
                if not rows:
                    return
                new_samples = []
                for label, ctype, lms_json in rows:
                    lms_raw = json.loads(lms_json)
                    if not lms_raw:
                        continue

                    if ctype == 'gesture':
                        # The UI sends [[{x,y,z}, ...]] for gestures. Extract the first hand.
                        hand = lms_raw[0] if (isinstance(lms_raw, list) and len(
                            lms_raw) > 0 and isinstance(lms_raw[0], list)) else lms_raw
                        norm = self.normalize_landmarks(hand)
                        if norm is not None:
                            new_samples.append({"label": label, "data": norm})
                    elif ctype == 'motion':
                        for frame in lms_raw:
                            # Each frame is usually [[{x,y,z}, ...]]
                            hand = frame[0] if (isinstance(frame, list) and len(
                                frame) > 0 and isinstance(frame[0], list)) else frame
                            norm = self.normalize_landmarks(hand)
                            if norm is not None:
                                new_samples.append(
                                    {"label": label, "data": norm})
                self.samples = new_samples
                print(
                    f"[Classifier] DB sync: {len(self.samples)} sample points.")
            finally:
                conn.close()
        except Exception as e:
            print(f"[Classifier] Error reloading DB: {e}")

    def train(self):
        """Train a Random Forest model and save to both Disk and Database."""
        if not SKLEARN_AVAILABLE:
            return False, "scikit-learn not installed"
        if len(self.samples) < 5:
            return False, "Not enough samples (need at least 5)"

        try:
            X = np.array([s['data'] for s in self.samples])
            y = np.array([s['label'] for s in self.samples])

            clf = RandomForestClassifier(n_estimators=100, max_depth=10)
            clf.fit(X, y)

            self.model = clf
            self.classes = list(clf.classes_)

            # 1. Save to Disk (Temporary on Vercel)
            payload = {'model': clf, 'classes': self.classes}
            with open(self.model_path, 'wb') as f:
                pickle.dump(payload, f)

            # 2. Save to Database (Permanent)
            conn = get_db_connection()
            try:
                binary_data = pickle.dumps(payload)
                if IS_POSTGRES:
                    # UPSERT for Postgres
                    execute_query(conn, """
                        INSERT INTO trained_models (name, data, updated_at) 
                        VALUES (?, ?, NOW()) 
                        ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
                    """, (self.model_name, binary_data), commit=True)
                else:
                    # UPSERT for SQLite
                    execute_query(conn, """
                        INSERT INTO trained_models (name, data, updated_at) 
                        VALUES (?, ?, datetime('now','localtime'))
                        ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at
                    """, (self.model_name, binary_data), commit=True)
            finally:
                conn.close()

            return True, f"Trained on {len(self.samples)} samples across {len(self.classes)} classes. Saved to Database."
        except Exception as e:
            print(f"[Classifier] Training error: {e}")
            return False, str(e)

    def normalize_landmarks(self, landmarks):
        """Normalize hand landmarks: translate to wrist origin and scale to unit length."""
        try:
            if not landmarks or len(landmarks) < 21:
                return None

            def get_xyz(lm):
                if isinstance(lm, dict):
                    return [lm['x'], lm['y'], lm['z']]
                if hasattr(lm, 'x'):
                    return [lm.x, lm.y, lm.z]
                return [lm[0], lm[1], lm[2]]  # Fallback

            arr = np.array([get_xyz(lm) for lm in landmarks])
            wrist = arr[0]
            arr = arr - wrist
            dists = np.linalg.norm(arr, axis=1)
            max_d = np.max(dists)
            if max_d > 0:
                arr = arr / max_d
            return arr.flatten()
        except:
            return None

    def classify(self, landmarks):
        """Classify landmarks using trained model (if available) or KNN search."""
        curr_norm = self.normalize_landmarks(landmarks)
        if curr_norm is None:
            return "—", 0.0

        # 1. Try trained model first
        if self.model and SKLEARN_AVAILABLE:
            try:
                X_in = curr_norm.reshape(1, -1)
                probs = self.model.predict_proba(X_in)[0]
                idx = np.argmax(probs)
                conf = probs[idx]
                if conf > 0.30:
                    return self.classes[idx], round(float(conf), 2)
            except:
                pass  # fallback to KNN

        # 2. KNN Fallback
        if not self.samples:
            return "—", 0.0

        best_label = "—"
        min_dist = 999.0
        for s in self.samples:
            dist = np.linalg.norm(curr_norm - s['data'])
            if dist < min_dist:
                min_dist = dist
                best_label = s['label']

        confidence = max(0.0, 1.0 - (min_dist / 0.5))
        if confidence < 0.4:
            return "—", 0.0
        return best_label, round(confidence, 2)


classifier = SignClassifier(DB_PATH)

# ── Routes ────────────────────────────────────────────────────────────────────


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/classify', methods=['POST'])
def api_classify():
    data = request.get_json()
    landmarks = data.get('landmarks', [])
    if not landmarks:
        return jsonify({"ok": False, "error": "No landmarks"}), 400

    sign, conf = classifier.classify(landmarks)
    return jsonify({"ok": True, "sign": sign, "conf": conf})


@app.route('/api/status')
def api_status():
    return jsonify({
        "status": "online",
        "sklearn": SKLEARN_AVAILABLE,
        "model_loaded": classifier.model is not None,
        "samples_count": len(classifier.samples),
        "timestamp": time.time(),
    })


@app.route('/api/dataset/save', methods=['POST'])
def save_dataset():
    data = request.get_json(force=True)
    label = data.get('label', '').strip().upper()
    mode = data.get('mode', 'ASL')
    capture_type = data.get('capture_type', 'gesture')
    landmarks = data.get('landmarks', [])

    if not label:
        return jsonify({"ok": False, "error": "empty label"}), 400

    frame_count = len(landmarks) if capture_type == 'motion' else 1

    conn = get_db_connection()
    try:
        _, sample_id = execute_query(
            conn,
            "INSERT INTO samples (label, mode, capture_type, landmarks, frame_count) VALUES (?,?,?,?,?)",
            (label, mode, capture_type, json.dumps(landmarks), frame_count),
            commit=True
        )
    finally:
        conn.close()

    classifier.reload()
    return jsonify({"ok": True, "id": sample_id, "label": label})


@app.route('/api/dataset/list')
def list_dataset():
    conn = get_db_connection()
    try:
        rows, _ = execute_query(
            conn,
            "SELECT id, label, mode, capture_type, frame_count, created_at FROM samples ORDER BY id DESC LIMIT 500"
        )
    finally:
        conn.close()
    
    return jsonify([
        {"id": r[0], "label": r[1], "mode": r[2],
         "type": r[3], "frames": r[4], "created_at": r[5]}
        for r in rows
    ])


@app.route('/api/dataset/delete/<int:sample_id>', methods=['DELETE'])
def delete_sample(sample_id):
    conn = get_db_connection()
    try:
        execute_query(conn, "DELETE FROM samples WHERE id = ?", (sample_id,), commit=True)
    finally:
        conn.close()
    classifier.reload()
    return jsonify({"ok": True})


@app.route('/api/dataset/delete_all', methods=['POST', 'DELETE'])
def delete_all_samples():
    conn = get_db_connection()
    try:
        execute_query(conn, "DELETE FROM samples", commit=True)
    finally:
        conn.close()
    classifier.reload()
    return jsonify({"ok": True, "message": "All samples deleted"})


@app.route('/api/dataset/download-db')
def download_db():
    """Download the raw SQLite database file (useful for syncing Vercel data back locally)."""
    if IS_POSTGRES:
        return jsonify({"error": "Direct DB download not supported for PostgreSQL"}), 400
    return send_file(DB_PATH, as_attachment=True, download_name='dataset.db',
                     mimetype='application/octet-stream')


@app.route('/api/dataset/import', methods=['POST'])
def import_dataset():
    """Merge records from an exported JSON into the current database."""
    data = request.get_json(force=True)
    records = data if isinstance(data, list) else data.get('records', [])
    if not records:
        return jsonify({"ok": False, "error": "No records provided"}), 400

    imported = 0
    conn = get_db_connection()
    try:
        for r in records:
            execute_query(
                conn,
                "INSERT INTO samples (label, mode, capture_type, landmarks, frame_count, created_at) VALUES (?,?,?,?,?,?)",
                (r['label'], r.get('mode', 'ASL'), r.get('type', 'gesture'),
                 json.dumps(r['landmarks']), r.get('frame_count', 1),
                 r.get('created_at', '')),
                commit=True
            )
            imported += 1
    finally:
        conn.close()
    classifier.reload()
    return jsonify({"ok": True, "imported": imported})


@app.route('/api/dataset/export')
def export_dataset():
    conn = get_db_connection()
    try:
        rows, _ = execute_query(
            conn,
            "SELECT id, label, mode, capture_type, landmarks, frame_count, created_at FROM samples ORDER BY id"
        )
    finally:
        conn.close()
    records = [
        {"id": r[0], "label": r[1], "mode": r[2], "type": r[3],
         "landmarks": json.loads(r[4]), "frame_count": r[5], "created_at": str(r[6])}
        for r in rows
    ]
    return jsonify(records)


@app.route('/api/dataset/playback/<int:sample_id>')
def playback_sample(sample_id):
    conn = get_db_connection()
    try:
        rows, _ = execute_query(
            conn,
            "SELECT id, label, mode, capture_type, landmarks, frame_count, created_at FROM samples WHERE id = ?",
            (sample_id,)
        )
    finally:
        conn.close()
        
    if not rows:
        return jsonify({"error": "not found"}), 404
    
    row = rows[0]
    record = {
        "id": row[0], "label": row[1], "mode": row[2],
        "type": row[3], "landmarks": json.loads(row[4]),
        "frame_count": row[5], "created_at": str(row[6]),
    }
    return jsonify(record)


@app.route('/api/dataset/stats')
def dataset_stats():
    conn = get_db_connection()
    try:
        total_rows, _ = execute_query(conn, "SELECT COUNT(*) FROM samples")
        total = total_rows[0][0] if total_rows else 0
        
        by_label, _ = execute_query(
            conn,
            "SELECT label, mode, capture_type, COUNT(*) FROM samples GROUP BY label, mode, capture_type ORDER BY label"
        )
    finally:
        conn.close()
        
    return jsonify({
        "total":    total,
        "by_label": [
            {"label": r[0], "mode": r[1], "type": r[2], "count": r[3]}
            for r in by_label
        ],
    })


def _model_path(name):
    """Return the writable path for a model file.
    On Vercel /var/task is read-only, so new models go to /tmp.
    For loading we check /tmp first (user-trained), then _repo_dir (bundled)."""
    if os.environ.get('VERCEL'):
        tmp_path = os.path.join('/tmp', name)
        if os.path.exists(tmp_path):
            return tmp_path
        return os.path.join(_repo_dir, name)
    return os.path.join(_repo_dir, name)


def _model_save_path(name):
    """Return the writable directory for saving new models."""
    save_dir = '/tmp' if os.environ.get('VERCEL') else _repo_dir
    return os.path.join(save_dir, name)


@app.route('/api/models/list')
def list_models():
    db_models = set()
    hidden = set()
    try:
        conn = get_db_connection()
        try:
            rows, _ = execute_query(conn, "SELECT name FROM trained_models")
            db_models = {r[0] for r in rows}
            hrows, _ = execute_query(conn, "SELECT name FROM hidden_models")
            hidden = {r[0] for r in hrows}
        finally:
            conn.close()
    except Exception as e:
        print(f"[Models] DB list error: {e}")

    # Filesystem models (repo + /tmp on Vercel)
    fs_models = set()
    if os.environ.get('VERCEL'):
        fs_models |= {f for f in os.listdir('/tmp') if f.endswith('.pkl')}
    fs_models |= {f for f in os.listdir(_repo_dir) if f.endswith('.pkl')}

    files = (db_models | fs_models) - hidden
    current = os.path.basename(classifier.model_path)
    return jsonify({"models": sorted(files), "current": current})


@app.route('/api/models/load', methods=['POST'])
def load_named_model():
    data = request.get_json()
    name = data.get('name')
    if not name or not name.endswith('.pkl'):
        return jsonify({"ok": False, "error": "Invalid model name"}), 400

    path = _model_path(name)
    if os.path.exists(path):
        classifier.model_path = path
        classifier.load_model()
        return jsonify({"ok": True, "message": f"Loaded {name}"})
    return jsonify({"ok": False, "error": "File not found"}), 404


@app.route('/api/models/delete', methods=['DELETE'])
def delete_named_model():
    data = request.get_json()
    name = data.get('name')
    if not name or not name.endswith('.pkl'):
        return jsonify({"ok": False, "error": "Invalid model name"}), 400

    if name == 'gesture_model.pkl':
        return jsonify({"ok": False, "error": "Cannot delete default model"}), 400

    conn = get_db_connection()
    try:
        # Remove from trained_models (DB-stored models)
        execute_query(conn, "DELETE FROM trained_models WHERE name = ?", (name,), commit=True)
        # Add to hidden_models so filesystem-bundled .pkl files also disappear from list
        if IS_POSTGRES:
            execute_query(conn, """
                INSERT INTO hidden_models (name) VALUES (?)
                ON CONFLICT (name) DO NOTHING
            """, (name,), commit=True)
        else:
            execute_query(conn, """
                INSERT OR IGNORE INTO hidden_models (name) VALUES (?)
            """, (name,), commit=True)
    except Exception as e:
        print(f"[Models] DB delete error: {e}")
    finally:
        conn.close()

    # Delete from disk (best effort — Vercel /var/task is read-only)
    for candidate in [os.path.join('/tmp', name), os.path.join(_repo_dir, name)]:
        if os.path.exists(candidate):
            try:
                os.remove(candidate)
            except Exception:
                pass

    return jsonify({"ok": True, "message": f"Deleted {name}"})


@app.route('/api/train', methods=['POST'])
def train_model():
    data = request.get_json() or {}
    model_name = data.get('model_name', 'gesture_model.pkl')
    if not model_name.endswith('.pkl'):
        model_name += '.pkl'

    classifier.model_path = _model_save_path(model_name)
    ok, msg = classifier.train()
    return jsonify({"ok": ok, "message": msg, "model_name": model_name})


@app.route('/api/interpret', methods=['POST'])
def interpret_signs():
    import urllib.request
    data = request.get_json(force=True)
    signs = data.get('signs', [])
    api_key = data.get('api_key', '').strip()

    if not signs:
        return jsonify({"ok": False, "error": "No signs provided"}), 400
    if not api_key:
        return jsonify({"ok": False, "error": "No API key provided"}), 400

    prompt = (
        f"You are an expert ASL (American Sign Language) and FSL (Filipino Sign Language) interpreter.\n\n"
        f"Your task is to take direct sign language text (gloss) and translate it into natural, grammatically correct, and conversational English.\n\n"
        f"CRITICAL RULE: Focus on MEANING-BASED translation, not word-for-word translation. Sign languages use different syntax (like Time-Topic-Comment). You must reorder and contextualize the signs to output the true intent of the sentence.\n\n"
        f"Guidelines:\n"
        f"1. Fix the syntax: Convert ASL/FSL grammar into standard English Subject-Verb-Object structures.\n"
        f"2. Add missing words: Sign language often drops articles (a, an, the) and \"to be\" verbs (is, are, am). Add these back in to make the sentence sound natural.\n"
        f"3. Preserve the tone: Keep the translation appropriate to the context (e.g., a question should sound like a natural question).\n\n"
        f"Examples:\n"
        f"- Input (Gloss): \"STORE TOMORROW I GO\"\n"
        f"- Output: \"I will go to the store tomorrow.\"\n\n"
        f"- Input (Gloss): \"YOU NAME WHAT?\"\n"
        f"- Output: \"What is your name?\"\n\n"
        f"- Input (Gloss): \"YESTERDAY CAR MY BREAK-DOWN\"\n"
        f"- Output: \"My car broke down yesterday.\"\n\n"
        f"- Input (Gloss): \"CAT TREE CLIMB FAST\"\n"
        f"- Output: \"The cat climbed the tree fast.\"\n\n"
        f"Translate the following ASL/FSL gloss into a natural sentence:\n"
        f"Input: {' '.join(signs)}\n"
        f"Output:"
    )

    payload = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 200,
        "messages": [{"role": "user", "content": prompt}]
    }

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            text = result["content"][0]["text"].strip()
            return jsonify({"ok": True, "interpretation": text})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, port=5000)
