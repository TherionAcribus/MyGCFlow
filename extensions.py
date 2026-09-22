from flask_babel import Babel
from flask_compress import Compress
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
babel = Babel()
compress = Compress()
